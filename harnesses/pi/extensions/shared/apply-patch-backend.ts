import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type ApplyPatchChangeType = "add" | "update" | "delete" | "move";

export type ApplyPatchBackendChange = {
	path: string;
	type: ApplyPatchChangeType;
	additions: number;
	deletions: number;
	move_path?: string | null;
};

export type ApplyPatchBackendResult = {
	stdout: string;
	stderr: string;
	diff: string;
	changes: ApplyPatchBackendChange[];
};

type PatchLine = {
	kind: "context" | "add" | "remove";
	text: string;
};

type PatchHunk = {
	anchor?: string;
	lineStart?: number;
	lines: PatchLine[];
};

type Operation =
	| { type: "add"; path: string; lines: string[] }
	| { type: "delete"; path: string }
	| { type: "move"; path: string; moveTo: string }
	| { type: "update"; path: string; moveTo?: string; hunks: PatchHunk[] }
	| { type: "replaceAll"; path: string; expected?: number; oldLines: string[]; newLines: string[] };

type FileSnapshot = {
	raw: string;
	bom: string;
	eol: "\n" | "\r\n";
	text: string;
	lines: string[];
};

const TOP_LEVEL_HEADERS = [
	"*** Add File: ",
	"*** Delete File: ",
	"*** Update File: ",
	"*** Move File: ",
	"*** Replace All In File: ",
	"*** Update Scope: ",
	"*** End Patch",
];

function normalizePatchInput(input: string): string[] {
	return input.replace(/\r\n?/g, "\n").split("\n");
}

function isTopLevelHeader(line: string): boolean {
	return TOP_LEVEL_HEADERS.some((header) => line.startsWith(header));
}

function assertPath(value: string, context: string): string {
	const path = value.trim();
	if (!path) throw new Error(`${context} requires a non-empty path.`);
	return path;
}

function parsePatchInput(input: string): Operation[] {
	const lines = normalizePatchInput(input);
	let index = 0;

	if (lines[index] !== "*** Begin Patch") {
		throw new Error("apply_patch payload must start with *** Begin Patch.");
	}
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
			const path = assertPath(line.slice("*** Add File: ".length), "*** Add File");
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
			operations.push({ type: "delete", path: assertPath(line.slice("*** Delete File: ".length), "*** Delete File") });
			index += 1;
			continue;
		}

		if (line.startsWith("*** Move File: ")) {
			const spec = line.slice("*** Move File: ".length);
			const match = /^(.*?)\s+->\s+(.*?)$/.exec(spec);
			if (!match) throw new Error("*** Move File must use 'old -> new'.");
			operations.push({
				type: "move",
				path: assertPath(match[1] ?? "", "*** Move File"),
				moveTo: assertPath(match[2] ?? "", "*** Move File"),
			});
			index += 1;
			continue;
		}

		if (line.startsWith("*** Update File: ")) {
			const path = assertPath(line.slice("*** Update File: ".length), "*** Update File");
			index += 1;
			let moveTo: string | undefined;
			if ((lines[index] ?? "").startsWith("*** Move to: ")) {
				moveTo = assertPath((lines[index] ?? "").slice("*** Move to: ".length), "*** Move to");
				index += 1;
			}
			const hunks = parseHunks(
				lines,
				() => index,
				(next) => (index = next),
				path,
			);
			operations.push({ type: "update", path, moveTo, hunks });
			continue;
		}

		if (line.startsWith("*** Replace All In File: ")) {
			const path = assertPath(line.slice("*** Replace All In File: ".length), "*** Replace All In File");
			index += 1;
			let expected: number | undefined;
			const expectLine = lines[index] ?? "";
			if (expectLine.startsWith("*** Expect Replacements: ")) {
				expected = Number(expectLine.slice("*** Expect Replacements: ".length));
				if (!Number.isFinite(expected)) throw new Error(`Invalid replacement count for ${path}.`);
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

		if (line.startsWith("*** Update Scope: ")) {
			const path = assertPath(line.slice("*** Update Scope: ".length), "*** Update Scope");
			index += 1;
			const hunks = parseHunks(
				lines,
				() => index,
				(next) => (index = next),
				path,
			);
			operations.push({ type: "update", path, hunks });
			continue;
		}

		throw new Error(`Unsupported apply_patch line: ${line}`);
	}

	throw new Error("apply_patch payload is missing *** End Patch.");
}

function parseHunks(
	lines: string[],
	getIndex: () => number,
	setIndex: (index: number) => void,
	path: string,
): PatchHunk[] {
	const hunks: PatchHunk[] = [];
	let index = getIndex();
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
			current = { anchor: line.slice(2).trim(), lineStart: range ? Number(range[1]) : undefined, lines: [] };
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
	setIndex(index);
	if (hunks.length === 0) throw new Error(`Update for ${path} has no hunks.`);
	return hunks;
}

function absoluteInside(cwd: string, path: string): string {
	const target = resolve(cwd, path);
	const rel = relative(cwd, target);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
	throw new Error(`Refusing to modify path outside cwd: ${path}`);
}

function stripBom(raw: string): { bom: string; text: string } {
	return raw.charCodeAt(0) === 0xfeff ? { bom: raw.slice(0, 1), text: raw.slice(1) } : { bom: "", text: raw };
}

function detectLineEnding(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function readSnapshot(cwd: string, path: string): Promise<FileSnapshot> {
	const raw = await readFile(absoluteInside(cwd, path), "utf-8");
	const { bom, text } = stripBom(raw);
	const eol = detectLineEnding(text);
	const normalized = normalizeText(text);
	return { raw, bom, eol, text: normalized, lines: normalized.split("\n") };
}

function restoreText(snapshot: FileSnapshot | undefined, text: string): string {
	const eol = snapshot?.eol ?? "\n";
	const bom = snapshot?.bom ?? "";
	return bom + (eol === "\n" ? text : text.replace(/\n/g, "\r\n"));
}

function textFromAddedLines(lines: string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function countPatchLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function displayLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function makeUnifiedDiff(path: string, before: string, after: string, newPath = path): string {
	if (before === after && path === newPath) return "";
	const beforeLines = displayLines(before);
	const afterLines = displayLines(after);
	const oldName = before.length === 0 ? "/dev/null" : `a/${path}`;
	const newName = after.length === 0 ? "/dev/null" : `b/${newPath}`;
	const lines = [`--- ${oldName}`, `+++ ${newName}`, `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`];
	lines.push(...beforeLines.map((line) => `-${line}`));
	lines.push(...afterLines.map((line) => `+${line}`));
	return `${lines.join("\n")}\n`;
}

function exactMatchAt(lines: string[], start: number, needle: string[]): boolean {
	if (start < 0 || start + needle.length > lines.length) return false;
	for (let offset = 0; offset < needle.length; offset += 1) {
		if (lines[start + offset] !== needle[offset]) return false;
	}
	return true;
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
		if (oldLines.length === 0) throw new Error(`Hunk for ${path} needs context or removed lines.`);

		let index = -1;
		if (hunk.lineStart !== undefined) {
			const hinted = hunk.lineStart - 1;
			if (exactMatchAt(lines, hinted, oldLines)) index = hinted;
			for (let delta = 1; index === -1 && delta <= 3; delta += 1) {
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

function countChangedLines(before: string, after: string): { additions: number; deletions: number } {
	if (before === after) return { additions: 0, deletions: 0 };
	return { additions: countPatchLines(after), deletions: countPatchLines(before) };
}

function summaryLine(change: ApplyPatchBackendChange): string {
	switch (change.type) {
		case "add":
			return `A ${change.path}`;
		case "delete":
			return `D ${change.path}`;
		case "move":
			return `R ${change.path} -> ${change.move_path}`;
		default:
			return `M ${change.path}`;
	}
}

export async function runLocalApplyPatch(
	cwd: string,
	input: string,
	options: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<ApplyPatchBackendResult> {
	const operations = parsePatchInput(input);
	const changes: ApplyPatchBackendChange[] = [];
	const diffs: string[] = [];

	for (const operation of operations) {
		if (options.signal?.aborted) throw new Error("apply_patch aborted.");

		if (operation.type === "add") {
			const target = absoluteInside(cwd, operation.path);
			if (existsSync(target)) throw new Error(`File already exists: ${operation.path}`);
			const after = textFromAddedLines(operation.lines);
			if (!options.dryRun) {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, after, "utf-8");
			}
			const additions = countPatchLines(after);
			changes.push({ path: operation.path, type: "add", additions, deletions: 0 });
			diffs.push(makeUnifiedDiff(operation.path, "", after));
			continue;
		}

		if (operation.type === "delete") {
			const snapshot = await readSnapshot(cwd, operation.path);
			if (!options.dryRun) await rm(absoluteInside(cwd, operation.path));
			const deletions = countPatchLines(snapshot.text);
			changes.push({ path: operation.path, type: "delete", additions: 0, deletions });
			diffs.push(makeUnifiedDiff(operation.path, snapshot.text, ""));
			continue;
		}

		if (operation.type === "move") {
			const snapshot = await readSnapshot(cwd, operation.path);
			if (!options.dryRun) {
				await mkdir(dirname(absoluteInside(cwd, operation.moveTo)), { recursive: true });
				await rename(absoluteInside(cwd, operation.path), absoluteInside(cwd, operation.moveTo));
			}
			changes.push({ path: operation.path, type: "move", additions: 0, deletions: 0, move_path: operation.moveTo });
			diffs.push(makeUnifiedDiff(operation.path, snapshot.text, snapshot.text, operation.moveTo));
			continue;
		}

		if (operation.type === "replaceAll") {
			const snapshot = await readSnapshot(cwd, operation.path);
			const oldText = textFromAddedLines(operation.oldLines);
			const newText = textFromAddedLines(operation.newLines);
			if (oldText.length === 0) throw new Error(`Replace-all for ${operation.path} needs removed lines.`);
			const pieces = snapshot.text.split(oldText);
			const replacements = pieces.length - 1;
			if (replacements === 0) throw new Error(`Could not find replace-all text in ${operation.path}.`);
			if (operation.expected !== undefined && replacements !== operation.expected) {
				throw new Error(`Expected ${operation.expected} replacements in ${operation.path}, found ${replacements}.`);
			}
			const after = pieces.join(newText);
			if (!options.dryRun) await writeFile(absoluteInside(cwd, operation.path), restoreText(snapshot, after), "utf-8");
			const counts = countChangedLines(snapshot.text, after);
			changes.push({ path: operation.path, type: "update", ...counts });
			diffs.push(makeUnifiedDiff(operation.path, snapshot.text, after));
			continue;
		}

		const snapshot = await readSnapshot(cwd, operation.path);
		const after = applyHunks(operation.path, snapshot.text, operation.hunks);
		if (after === snapshot.text && !operation.moveTo) throw new Error(`Patch made no changes to ${operation.path}.`);
		if (!options.dryRun) {
			const targetPath = operation.moveTo ?? operation.path;
			await mkdir(dirname(absoluteInside(cwd, targetPath)), { recursive: true });
			await writeFile(absoluteInside(cwd, targetPath), restoreText(snapshot, after), "utf-8");
			if (operation.moveTo) await rm(absoluteInside(cwd, operation.path));
		}
		const counts = countChangedLines(snapshot.text, after);
		changes.push({
			path: operation.path,
			type: operation.moveTo ? "move" : "update",
			...counts,
			move_path: operation.moveTo ?? null,
		});
		diffs.push(makeUnifiedDiff(operation.path, snapshot.text, after, operation.moveTo ?? operation.path));
	}

	const diff = diffs.filter(Boolean).join("\n");
	const stdout = options.dryRun ? diff : `${changes.map(summaryLine).join("\n")}${changes.length ? "\n" : ""}`;
	return { stdout, stderr: "", diff, changes };
}
