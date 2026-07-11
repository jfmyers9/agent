// Port of OpenAI Codex's apply_patch file-operation grammar and matching behavior.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type ApplyPatchChangeType = "add" | "update" | "delete" | "move";

export type ApplyPatchChange = {
	path: string;
	type: ApplyPatchChangeType;
	additions: number;
	deletions: number;
	movePath?: string;
};

export type ApplyPatchResult = {
	stdout: string;
	stderr: string;
	diff: string;
	changes: ApplyPatchChange[];
};

type PatchLine = { kind: "context" | "add" | "remove"; text: string };
type PatchHunk = { anchor?: string; lineStart?: number; lines: PatchLine[] };
type Operation =
	| { type: "add"; path: string; lines: string[] }
	| { type: "delete"; path: string }
	| { type: "move"; path: string; movePath: string }
	| { type: "update"; path: string; movePath?: string; hunks: PatchHunk[] }
	| { type: "replaceAll"; path: string; expected?: number; oldLines: string[]; newLines: string[] };

type Snapshot = { bom: string; eol: "\n" | "\r\n"; text: string; raw: string };
type VirtualFile = { path: string; snapshot?: Snapshot; text: string };

const TOP_LEVEL_HEADERS = [
	"*** Add File: ",
	"*** Delete File: ",
	"*** Update File: ",
	"*** Move File: ",
	"*** Replace All In File: ",
	"*** Update Scope: ",
	"*** End Patch",
];

function normalizedLines(input: string): string[] {
	return input.replace(/\r\n?/g, "\n").split("\n");
}

function isTopLevelHeader(line: string): boolean {
	return TOP_LEVEL_HEADERS.some((header) => line.startsWith(header));
}

function requirePath(value: string, label: string): string {
	const path = value.trim();
	if (!path) throw new Error(`${label} requires a non-empty path.`);
	return path;
}

function parseHunks(lines: string[], start: number, path: string): { hunks: PatchHunk[]; next: number } {
	const hunks: PatchHunk[] = [];
	let index = start;
	let current: PatchHunk | undefined;
	const flush = () => {
		if (current && current.lines.length > 0) hunks.push(current);
		current = undefined;
	};

	while (index < lines.length && !isTopLevelHeader(lines[index] ?? "")) {
		const line = lines[index] ?? "";
		if (line.startsWith("@@")) {
			flush();
			const range = /^@@ lines (\d+)(?:-\d+)?/.exec(line);
			current = {
				anchor: line.slice(2).trim(),
				lineStart: range ? Number(range[1]) : undefined,
				lines: [],
			};
			index += 1;
			continue;
		}
		if (line === "*** End of File") {
			index += 1;
			continue;
		}
		if (!current) current = { lines: [] };
		const prefix = line[0];
		if (prefix === " ") current.lines.push({ kind: "context", text: line.slice(1) });
		else if (prefix === "+") current.lines.push({ kind: "add", text: line.slice(1) });
		else if (prefix === "-") current.lines.push({ kind: "remove", text: line.slice(1) });
		else throw new Error(`Update lines for ${path} must start with ' ', '+', '-', '@@', or *** End of File.`);
		index += 1;
	}
	flush();
	if (hunks.length === 0) throw new Error(`Update for ${path} has no hunks.`);
	return { hunks, next: index };
}

export function parseApplyPatch(input: string): Operation[] {
	const lines = normalizedLines(input);
	let index = 0;
	if (lines[index] !== "*** Begin Patch") throw new Error("apply_patch payload must start with *** Begin Patch.");
	index += 1;
	const operations: Operation[] = [];

	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line === "" && index === lines.length - 1) break;
		if (line === "*** End Patch") return operations;
		if (line.startsWith("*** Intent: ") || line.startsWith("*** Environment ID: ")) {
			index += 1;
			continue;
		}
		if (line.startsWith("*** Add File: ")) {
			const path = requirePath(line.slice("*** Add File: ".length), "*** Add File");
			index += 1;
			const added: string[] = [];
			while (index < lines.length && !isTopLevelHeader(lines[index] ?? "")) {
				const current = lines[index] ?? "";
				if (!current.startsWith("+")) throw new Error(`Add file lines for ${path} must start with '+'.`);
				added.push(current.slice(1));
				index += 1;
			}
			operations.push({ type: "add", path, lines: added });
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			operations.push({ type: "delete", path: requirePath(line.slice("*** Delete File: ".length), "*** Delete File") });
			index += 1;
			continue;
		}
		if (line.startsWith("*** Move File: ")) {
			const match = /^(.*?)\s+->\s+(.*?)$/.exec(line.slice("*** Move File: ".length));
			if (!match) throw new Error("*** Move File must use 'old -> new'.");
			operations.push({
				type: "move",
				path: requirePath(match[1] ?? "", "*** Move File"),
				movePath: requirePath(match[2] ?? "", "*** Move File"),
			});
			index += 1;
			continue;
		}
		if (line.startsWith("*** Update File: ") || line.startsWith("*** Update Scope: ")) {
			const header = line.startsWith("*** Update File: ") ? "*** Update File: " : "*** Update Scope: ";
			const path = requirePath(line.slice(header.length), header.slice(0, -2));
			index += 1;
			let movePath: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				movePath = requirePath((lines[index] ?? "").slice("*** Move to: ".length), "*** Move to");
				index += 1;
			}
			const parsed = parseHunks(lines, index, path);
			operations.push({ type: "update", path, movePath, hunks: parsed.hunks });
			index = parsed.next;
			continue;
		}
		if (line.startsWith("*** Replace All In File: ")) {
			const path = requirePath(line.slice("*** Replace All In File: ".length), "*** Replace All In File");
			index += 1;
			let expected: number | undefined;
			if ((lines[index] ?? "").startsWith("*** Expect Replacements: ")) {
				expected = Number((lines[index] ?? "").slice("*** Expect Replacements: ".length));
				if (!Number.isInteger(expected) || expected < 0) throw new Error(`Invalid replacement count for ${path}.`);
				index += 1;
			}
			const oldLines: string[] = [];
			const newLines: string[] = [];
			while (index < lines.length && !isTopLevelHeader(lines[index] ?? "")) {
				const current = lines[index] ?? "";
				if (current.startsWith("-")) oldLines.push(current.slice(1));
				else if (current.startsWith("+")) newLines.push(current.slice(1));
				else throw new Error(`Replace-all lines for ${path} must start with '+' or '-'.`);
				index += 1;
			}
			operations.push({ type: "replaceAll", path, expected, oldLines, newLines });
			continue;
		}
		throw new Error(`Unsupported apply_patch line: ${line}`);
	}
	throw new Error("apply_patch payload is missing *** End Patch.");
}

function absoluteInside(cwd: string, path: string): string {
	const target = resolve(cwd, path);
	const rel = relative(resolve(cwd), target);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
	throw new Error(`Refusing to modify path outside cwd: ${path}`);
}

function snapshotFromRaw(raw: string): Snapshot {
	const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
	const withoutBom = bom ? raw.slice(1) : raw;
	return {
		bom,
		eol: withoutBom.includes("\r\n") ? "\r\n" : "\n",
		text: withoutBom.replace(/\r\n?/g, "\n"),
		raw,
	};
}

function restore(snapshot: Snapshot | undefined, text: string): string {
	const eol = snapshot?.eol ?? "\n";
	return (snapshot?.bom ?? "") + (eol === "\n" ? text : text.replace(/\n/g, "\r\n"));
}

function exactMatchAt(lines: string[], start: number, needle: string[]): boolean {
	if (start < 0 || start + needle.length > lines.length) return false;
	return needle.every((line, offset) => lines[start + offset] === line);
}

function findSequence(lines: string[], needle: string[], startAt: number): number {
	if (needle.length === 0) return -1;
	for (let index = Math.max(0, startAt); index <= lines.length - needle.length; index += 1) {
		if (exactMatchAt(lines, index, needle)) return index;
	}
	for (let index = 0; index < Math.max(0, startAt); index += 1) {
		if (exactMatchAt(lines, index, needle)) return index;
	}
	return -1;
}

function applyHunks(path: string, text: string, hunks: PatchHunk[]): string {
	const lines = text.split("\n");
	let cursor = 0;
	for (const hunk of hunks) {
		const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
		const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
		let index = -1;
		if (oldLines.length === 0) index = hunk.lineStart === undefined ? cursor : Math.max(0, hunk.lineStart - 1);
		if (index === -1 && hunk.lineStart !== undefined) {
			const hinted = hunk.lineStart - 1;
			if (exactMatchAt(lines, hinted, oldLines)) index = hinted;
			for (let delta = 1; delta <= 3 && index === -1; delta += 1) {
				if (exactMatchAt(lines, hinted - delta, oldLines)) index = hinted - delta;
				else if (exactMatchAt(lines, hinted + delta, oldLines)) index = hinted + delta;
			}
		}
		if (index === -1) index = findSequence(lines, oldLines, cursor);
		if (index === -1)
			throw new Error(`Could not find hunk context in ${path}${hunk.anchor ? ` (${hunk.anchor})` : ""}.`);
		lines.splice(index, oldLines.length, ...newLines);
		cursor = index + newLines.length;
	}
	return lines.join("\n");
}

function replaceAllLines(
	path: string,
	text: string,
	oldLines: string[],
	newLines: string[],
	expected?: number,
): string {
	if (oldLines.length === 0) throw new Error(`Replace-all for ${path} needs removed lines.`);
	const lines = text.split("\n");
	let replacements = 0;
	for (let index = 0; index <= lines.length - oldLines.length; ) {
		if (!exactMatchAt(lines, index, oldLines)) {
			index += 1;
			continue;
		}
		lines.splice(index, oldLines.length, ...newLines);
		replacements += 1;
		index += newLines.length;
	}
	if (replacements === 0) throw new Error(`Could not find replace-all text in ${path}.`);
	if (expected !== undefined && replacements !== expected) {
		throw new Error(`Expected ${expected} replacements in ${path}, found ${replacements}.`);
	}
	return lines.join("\n");
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function unifiedDiff(path: string, before: string, after: string, newPath = path): string {
	if (before === after && path === newPath) return "";
	const oldLines = before ? before.split("\n") : [];
	const newLines = after ? after.split("\n") : [];
	return `${[
		`--- ${before ? `a/${path}` : "/dev/null"}`,
		`+++ ${after ? `b/${newPath}` : "/dev/null"}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map((line) => `-${line}`),
		...newLines.map((line) => `+${line}`),
	].join("\n")}\n`;
}

function summary(change: ApplyPatchChange): string {
	if (change.type === "add") return `A ${change.path}`;
	if (change.type === "delete") return `D ${change.path}`;
	if (change.type === "move") return `R ${change.path} -> ${change.movePath}`;
	return `M ${change.path}`;
}

export async function runLocalApplyPatch(
	cwd: string,
	input: string,
	options: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<ApplyPatchResult> {
	const operations = parseApplyPatch(input);
	const virtual = new Map<string, VirtualFile | undefined>();
	const touched = new Set<string>();
	const changes: ApplyPatchChange[] = [];
	const diffs: string[] = [];

	const load = async (path: string): Promise<VirtualFile> => {
		const absolute = absoluteInside(cwd, path);
		if (virtual.has(absolute)) {
			const value = virtual.get(absolute);
			if (!value) throw new Error(`File does not exist: ${path}`);
			return value;
		}
		if (!existsSync(absolute)) throw new Error(`File does not exist: ${path}`);
		const snapshot = snapshotFromRaw(await readFile(absolute, "utf8"));
		const value = { path, snapshot, text: snapshot.text };
		virtual.set(absolute, value);
		return value;
	};
	const mark = (path: string) => {
		const absolute = absoluteInside(cwd, path);
		touched.add(absolute);
		return absolute;
	};

	for (const operation of operations) {
		if (options.signal?.aborted) throw new Error("apply_patch aborted.");
		if (operation.type === "add") {
			const absolute = mark(operation.path);
			if (virtual.has(absolute) ? virtual.get(absolute) : existsSync(absolute))
				throw new Error(`File already exists: ${operation.path}`);
			const after = operation.lines.length ? `${operation.lines.join("\n")}\n` : "";
			virtual.set(absolute, { path: operation.path, text: after });
			const change = { path: operation.path, type: "add" as const, additions: lineCount(after), deletions: 0 };
			changes.push(change);
			diffs.push(unifiedDiff(operation.path, "", after));
			continue;
		}
		if (operation.type === "delete") {
			const file = await load(operation.path);
			mark(operation.path);
			virtual.set(absoluteInside(cwd, operation.path), undefined);
			changes.push({ path: operation.path, type: "delete", additions: 0, deletions: lineCount(file.text) });
			diffs.push(unifiedDiff(operation.path, file.text, ""));
			continue;
		}
		if (operation.type === "move") {
			const file = await load(operation.path);
			const source = mark(operation.path);
			const target = mark(operation.movePath);
			if (virtual.has(target) ? virtual.get(target) : existsSync(target))
				throw new Error(`File already exists: ${operation.movePath}`);
			virtual.set(source, undefined);
			virtual.set(target, { ...file, path: operation.movePath });
			changes.push({ path: operation.path, type: "move", additions: 0, deletions: 0, movePath: operation.movePath });
			diffs.push(unifiedDiff(operation.path, file.text, file.text, operation.movePath));
			continue;
		}
		if (operation.type === "replaceAll") {
			const file = await load(operation.path);
			const after = replaceAllLines(
				operation.path,
				file.text,
				operation.oldLines,
				operation.newLines,
				operation.expected,
			);
			mark(operation.path);
			virtual.set(absoluteInside(cwd, operation.path), { ...file, text: after });
			changes.push({
				path: operation.path,
				type: "update",
				additions: lineCount(after),
				deletions: lineCount(file.text),
			});
			diffs.push(unifiedDiff(operation.path, file.text, after));
			continue;
		}
		const file = await load(operation.path);
		const after = applyHunks(operation.path, file.text, operation.hunks);
		if (after === file.text && !operation.movePath) throw new Error(`Patch made no changes to ${operation.path}.`);
		const source = mark(operation.path);
		if (operation.movePath) {
			const target = mark(operation.movePath);
			if (virtual.has(target) ? virtual.get(target) : existsSync(target))
				throw new Error(`File already exists: ${operation.movePath}`);
			virtual.set(source, undefined);
			virtual.set(target, { ...file, path: operation.movePath, text: after });
		} else {
			virtual.set(source, { ...file, text: after });
		}
		changes.push({
			path: operation.path,
			type: operation.movePath ? "move" : "update",
			additions: lineCount(after),
			deletions: lineCount(file.text),
			movePath: operation.movePath,
		});
		diffs.push(unifiedDiff(operation.path, file.text, after, operation.movePath ?? operation.path));
	}

	if (!options.dryRun) {
		for (const absolute of touched) {
			const value = virtual.get(absolute);
			if (value) {
				await mkdir(dirname(absolute), { recursive: true });
				await writeFile(absolute, restore(value.snapshot, value.text), "utf8");
			} else if (existsSync(absolute)) {
				await rm(absolute);
			}
		}
	}
	const diff = diffs.filter(Boolean).join("\n");
	return {
		stdout: options.dryRun ? diff : `${changes.map(summary).join("\n")}${changes.length ? "\n" : ""}`,
		stderr: "",
		diff,
		changes,
	};
}
