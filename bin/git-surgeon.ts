#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type View = "staged" | "unstaged";
type RequestedView = View | "all";

type RejectedFile = {
	view: View;
	file: string;
	reason: string;
};

type Hunk = {
	id: string;
	view: View;
	file: string;
	additions: number;
	deletions: number;
	preview: string;
	header: string;
	fileHeader: Buffer;
	content: Buffer;
};

type Snapshot = {
	hunks: Hunk[];
	rejected: RejectedFile[];
};

type ParsedArgs = {
	command: string;
	positionals: string[];
	json: boolean;
	view: RequestedView;
	yes: boolean;
	help: boolean;
};

class CliError extends Error {
	constructor(
		message: string,
		readonly exitCode = 1,
	) {
		super(message);
	}
}

const DIFF_OPTIONS = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--diff-algorithm=myers",
	"--no-indent-heuristic",
	"--find-renames=50%",
	"--find-copies=50%",
];

const HELP = `Usage:
  git-surgeon list [--view staged|unstaged|all] [--json]
  git-surgeon show <hunk-id> [--view staged|unstaged|all] [--json]
  git-surgeon stage <hunk-id>... [--json]
  git-surgeon unstage <hunk-id>... [--json]
  git-surgeon discard --yes <hunk-id>... [--json]

Hunk IDs describe the current diff only. Re-list after any diff change.
Only modified, tracked text files are eligible.`;

function runGit(root: string, args: string[]): Buffer {
	const result = spawnSync("git", args, {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw new CliError(`could not run git: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = (result.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
		throw new CliError(detail || `git ${args[0] ?? "command"} failed`);
	}
	return result.stdout ?? Buffer.alloc(0);
}

function repositoryRoot(): string {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
	if (result.error) throw new CliError(`could not run git: ${result.error.message}`);
	if (result.status !== 0) throw new CliError("not inside a Git working tree");
	return result.stdout.replace(/\r?\n$/, "");
}

function diffArguments(view: View, options: string[], path?: string): string[] {
	return [
		"--literal-pathspecs",
		"diff",
		...(view === "staged" ? ["--cached"] : []),
		...DIFF_OPTIONS,
		...options,
		"--",
		...(path === undefined ? [] : [path]),
	];
}

function splitNul(input: Buffer): Buffer[] {
	const fields: Buffer[] = [];
	let start = 0;
	for (let index = 0; index < input.length; index += 1) {
		if (input[index] !== 0) continue;
		fields.push(input.subarray(start, index));
		start = index + 1;
	}
	if (start < input.length) fields.push(input.subarray(start));
	return fields;
}

function displayPath(path: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(path);
	} catch {
		return `<non-UTF-8:${path.toString("hex")}>`;
	}
}

type RawEntry = {
	oldMode: string;
	newMode: string;
	status: string;
	paths: Buffer[];
};

function rawEntries(root: string, view: View): RawEntry[] {
	const fields = splitNul(runGit(root, diffArguments(view, ["--raw", "-z", "--no-abbrev"])));
	const entries: RawEntry[] = [];
	let index = 0;
	while (index < fields.length) {
		const metadata = fields[index]?.toString("ascii") ?? "";
		index += 1;
		if (!metadata.startsWith(":")) throw new CliError("could not parse Git raw diff output");
		const parts = metadata.slice(1).trim().split(/\s+/);
		if (parts.length < 5) throw new CliError("could not parse Git raw diff metadata");
		const status = parts[4] ?? "";
		const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
		const paths = fields.slice(index, index + pathCount);
		if (paths.length !== pathCount) throw new CliError("could not parse Git raw diff paths");
		index += pathCount;
		entries.push({ oldMode: parts[0] ?? "", newMode: parts[1] ?? "", status, paths });
	}
	return entries;
}

function rejection(entry: RawEntry): { file: string; reason: string } | undefined {
	const shownPaths = entry.paths.map(displayPath);
	const file = shownPaths.join(" -> ");
	if (entry.oldMode === "160000" || entry.newMode === "160000") return { file, reason: "submodule" };
	if (entry.status.startsWith("A")) return { file, reason: "added file" };
	if (entry.status.startsWith("D")) return { file, reason: "deleted file" };
	if (entry.status.startsWith("R")) return { file, reason: "renamed file" };
	if (entry.status.startsWith("C")) return { file, reason: "copied file" };
	if (entry.status.startsWith("T")) return { file, reason: "file type change" };
	if (entry.status !== "M") return { file, reason: `unsupported Git status ${entry.status}` };
	if (entry.oldMode !== entry.newMode) return { file, reason: "file mode change" };
	if (!entry.oldMode.startsWith("100")) return { file, reason: "non-regular file" };
	if (file.startsWith("<non-UTF-8:")) return { file, reason: "non-UTF-8 path" };
	return undefined;
}

type Line = { start: number; end: number };

function lines(input: Buffer): Line[] {
	const result: Line[] = [];
	let start = 0;
	for (let index = 0; index < input.length; index += 1) {
		if (input[index] !== 10) continue;
		result.push({ start, end: index + 1 });
		start = index + 1;
	}
	if (start < input.length) result.push({ start, end: input.length });
	return result;
}

function startsHunk(input: Buffer, line: Line): boolean {
	return startsLineWith(input, line, "@@ ");
}

function startsLineWith(input: Buffer, line: Line, prefix: string): boolean {
	const expected = Buffer.from(prefix);
	return (
		line.end - line.start >= expected.length &&
		input.subarray(line.start, line.start + expected.length).equals(expected)
	);
}

function hunkDetails(content: Buffer): Pick<Hunk, "additions" | "deletions" | "preview" | "header"> {
	const contentLines = lines(content);
	const header = content
		.subarray(contentLines[0]?.start ?? 0, contentLines[0]?.end ?? 0)
		.toString("utf8")
		.trimEnd();
	let additions = 0;
	let deletions = 0;
	let preview = "";
	for (const line of contentLines.slice(1)) {
		const marker = content[line.start];
		if (marker !== 43 && marker !== 45) continue;
		if (marker === 43) additions += 1;
		else deletions += 1;
		if (preview) continue;
		const source = content
			.subarray(line.start + 1, line.end)
			.toString("utf8")
			.trimEnd()
			.replace(/\s+/g, " ")
			.slice(0, 100);
		preview = `${marker === 43 ? "+" : "-"} ${source}`;
	}
	return { additions, deletions, preview, header };
}

function parsePatch(file: string, view: View, patch: Buffer): Omit<Hunk, "id">[] {
	const patchLines = lines(patch);
	const fileRecords = patchLines.filter((line) => startsLineWith(patch, line, "diff --git "));
	if (fileRecords.length !== 1) {
		throw new CliError(`expected one file patch for ${file}, received ${fileRecords.length}`);
	}
	const starts = patchLines.filter((line) => startsHunk(patch, line)).map((line) => line.start);
	if (starts.length === 0) return [];
	const fileHeader = patch.subarray(0, starts[0]);
	if (!fileHeader.subarray(0, 11).equals(Buffer.from("diff --git "))) {
		throw new CliError(`could not parse patch header for ${file}`);
	}
	return starts.map((start, index) => {
		const content = patch.subarray(start, starts[index + 1] ?? patch.length);
		return { view, file, fileHeader, content, ...hunkDetails(content) };
	});
}

function snapshot(root: string, requestedView: RequestedView): Snapshot {
	const views: View[] = requestedView === "all" ? ["unstaged", "staged"] : [requestedView];
	const pending: Omit<Hunk, "id">[] = [];
	const rejected: RejectedFile[] = [];

	for (const view of views) {
		for (const entry of rawEntries(root, view)) {
			const denied = rejection(entry);
			if (denied) {
				rejected.push({ view, ...denied });
				continue;
			}
			const file = displayPath(entry.paths[0]!);
			const numstat = runGit(root, diffArguments(view, ["--numstat", "-z"], file));
			if (numstat.subarray(0, 3).equals(Buffer.from("-\t-"))) {
				rejected.push({ view, file, reason: "binary file" });
				continue;
			}
			const patch = runGit(
				root,
				diffArguments(
					view,
					["--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "--inter-hunk-context=0"],
					file,
				),
			);
			const parsed = parsePatch(file, view, patch);
			if (parsed.length === 0) {
				rejected.push({ view, file, reason: "no selectable text hunks" });
				continue;
			}
			pending.push(...parsed);
		}
	}

	const collisions = new Map<string, number>();
	const hunks = pending.map((hunk) => {
		const base = createHash("sha256")
			.update(hunk.view)
			.update("\0")
			.update(hunk.file)
			.update("\0")
			.update(hunk.content)
			.digest("hex")
			.slice(0, 10);
		const occurrence = (collisions.get(base) ?? 0) + 1;
		collisions.set(base, occurrence);
		return { ...hunk, id: occurrence === 1 ? base : `${base}-${occurrence}` };
	});

	return { hunks, rejected };
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command = "", ...rest] = argv;
	const parsed: ParsedArgs = {
		command,
		positionals: [],
		json: false,
		view: "all",
		yes: false,
		help: command === "help",
	};
	for (let index = 0; index < rest.length; index += 1) {
		const argument = rest[index] ?? "";
		if (argument === "--json") parsed.json = true;
		else if (argument === "--yes") parsed.yes = true;
		else if (argument === "--help" || argument === "-h") parsed.help = true;
		else if (argument === "--view") {
			const view = rest[index + 1];
			if (view !== "staged" && view !== "unstaged" && view !== "all") {
				throw new CliError("--view must be staged, unstaged, or all", 2);
			}
			parsed.view = view;
			index += 1;
		} else if (argument.startsWith("-")) throw new CliError(`unknown option: ${argument}`, 2);
		else parsed.positionals.push(argument);
	}
	return parsed;
}

function publicHunk(hunk: Hunk, includeContent = false) {
	return {
		id: hunk.id,
		view: hunk.view,
		file: hunk.file,
		additions: hunk.additions,
		deletions: hunk.deletions,
		header: hunk.header,
		preview: hunk.preview,
		...(includeContent ? { content: hunk.content.toString("utf8") } : {}),
	};
}

function escapedField(value: string): string {
	return JSON.stringify(value);
}

function printList(current: Snapshot, json: boolean): void {
	if (json) {
		process.stdout.write(
			`${JSON.stringify({ hunks: current.hunks.map((hunk) => publicHunk(hunk)), rejected: current.rejected }, null, 2)}\n`,
		);
		return;
	}
	if (current.hunks.length === 0) process.stdout.write("No selectable text hunks.\n");
	else {
		process.stdout.write("ID\tVIEW\tFILE\tSTATS\tPREVIEW\n");
		for (const hunk of current.hunks) {
			process.stdout.write(
				`${hunk.id}\t${hunk.view}\t${escapedField(hunk.file)}\t+${hunk.additions}/-${hunk.deletions}\t${escapedField(hunk.preview)}\n`,
			);
		}
	}
	if (current.rejected.length > 0) {
		process.stdout.write("Rejected files:\n");
		for (const item of current.rejected) {
			process.stdout.write(`${item.view}\t${escapedField(item.file)}\t${item.reason}\n`);
		}
	}
}

function showHunk(current: Snapshot, id: string, json: boolean): void {
	const hunk = current.hunks.find((candidate) => candidate.id === id);
	if (!hunk) throw new CliError(`hunk ID not found in fresh snapshot: ${id}; run git-surgeon list again`);
	if (json) {
		process.stdout.write(`${JSON.stringify({ hunk: publicHunk(hunk, true) }, null, 2)}\n`);
		return;
	}
	process.stdout.write(`ID\t${hunk.id}\nVIEW\t${hunk.view}\nFILE\t${escapedField(hunk.file)}\n`);
	process.stdout.write(hunk.content);
	if (hunk.content.at(-1) !== 10) process.stdout.write("\n");
}

function selectivePatch(selected: Hunk[]): Buffer {
	const chunks: Buffer[] = [];
	let previousFile: string | undefined;
	for (const hunk of selected) {
		if (hunk.file !== previousFile) {
			chunks.push(hunk.fileHeader);
			previousFile = hunk.file;
		}
		chunks.push(hunk.content);
	}
	return Buffer.concat(chunks);
}

function applyOperation(root: string, operation: "stage" | "unstage" | "discard", ids: string[], json: boolean): void {
	const view: View = operation === "unstage" ? "staged" : "unstaged";
	const current = snapshot(root, view);
	const uniqueIds = [...new Set(ids)];
	const selectedIds = new Set(uniqueIds);
	const missing = uniqueIds.filter((id) => !current.hunks.some((hunk) => hunk.id === id));
	if (missing.length > 0) {
		throw new CliError(
			`hunk ID(s) not found in fresh ${view} snapshot: ${missing.join(", ")}; run git-surgeon list --view ${view} again`,
		);
	}
	const selected = current.hunks.filter((hunk) => selectedIds.has(hunk.id));
	const patch = selectivePatch(selected);
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "git-surgeon-"));
	const patchFile = join(temporaryDirectory, "selected.patch");
	try {
		writeFileSync(patchFile, patch, { mode: 0o600 });
		const options =
			operation === "stage" ? ["--cached"] : operation === "unstage" ? ["--cached", "--reverse"] : ["--reverse"];
		runGit(root, ["apply", ...options, "--whitespace=nowarn", "--check", patchFile]);
		runGit(root, ["apply", ...options, "--whitespace=nowarn", patchFile]);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}

	const files = [...new Set(selected.map((hunk) => hunk.file))];
	const output = { operation, ids: uniqueIds, files };
	if (json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
	else {
		const completed = operation === "stage" ? "staged" : operation === "unstage" ? "unstaged" : "discarded";
		process.stdout.write(`${completed} ${uniqueIds.length} hunk(s) in ${files.length} file(s).\n`);
	}
}

function requirePositionals(parsed: ParsedArgs, count: number | "some"): void {
	const valid = count === "some" ? parsed.positionals.length > 0 : parsed.positionals.length === count;
	if (!valid) throw new CliError(`invalid arguments for ${parsed.command}; see git-surgeon --help`, 2);
}

function execute(argv: string[]): void {
	const parsed = parseArgs(argv);
	if (parsed.help || parsed.command === "--help" || parsed.command === "-h") {
		process.stdout.write(`${HELP}\n`);
		return;
	}
	if (!parsed.command) throw new CliError("missing command; see git-surgeon --help", 2);
	const root = repositoryRoot();

	if (parsed.command === "list") {
		requirePositionals(parsed, 0);
		if (parsed.yes) throw new CliError("--yes is valid only with discard", 2);
		printList(snapshot(root, parsed.view), parsed.json);
		return;
	}
	if (parsed.command === "show") {
		requirePositionals(parsed, 1);
		if (parsed.yes) throw new CliError("--yes is valid only with discard", 2);
		showHunk(snapshot(root, parsed.view), parsed.positionals[0]!, parsed.json);
		return;
	}
	if (parsed.command === "stage" || parsed.command === "unstage" || parsed.command === "discard") {
		requirePositionals(parsed, "some");
		if (parsed.view !== "all") throw new CliError("--view is valid only with list and show", 2);
		if (parsed.command === "discard" && !parsed.yes) {
			throw new CliError("discard is destructive; pass --yes after explicit approval", 2);
		}
		if (parsed.command !== "discard" && parsed.yes) {
			throw new CliError("--yes is valid only with discard", 2);
		}
		applyOperation(root, parsed.command, parsed.positionals, parsed.json);
		return;
	}
	throw new CliError(`unknown command: ${parsed.command}; see git-surgeon --help`, 2);
}

const jsonErrors = process.argv.includes("--json");
try {
	execute(process.argv.slice(2));
} catch (error) {
	const failure =
		error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error));
	if (jsonErrors) process.stderr.write(`${JSON.stringify({ error: failure.message })}\n`);
	else process.stderr.write(`git-surgeon: ${failure.message}\n`);
	process.exitCode = failure.exitCode;
}
