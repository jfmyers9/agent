// @ts-nocheck
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
	keyHint,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Box, type Text } from "@earendil-works/pi-tui";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";
import { runCommand as runExternalCommand } from "../shared/command-runner.ts";
import { EmptyComponent, runningFrame, shineText, textComponent } from "../shared/tui";
import { columnCountForWidth, renderColumns } from "./columns.ts";
import {
	buildHighlightedDiffRows,
	type DiffRenderRow,
	type DiffSectionHeaderRenderer,
	EditDiffView,
	highlightCodeRows,
	highlightCodeRowsSync,
	highlightSearchMatches,
	languageFromPath,
	type RenderTheme,
} from "./diff-render.ts";
import { HASHLINE_SNAPSHOTS, recordHashlineContiguous, recordHashlineSparse } from "./hashline/anchors.js";
import { buildCompactDiffPreview } from "./hashline/diff-preview.ts";
import { formatHashlineHeader, formatNumberedLines } from "./hashline/format.ts";
import { Filesystem, NotFoundError, type WriteResult } from "./hashline/fs.ts";
import { Patch } from "./hashline/input.ts";
import { Patcher } from "./hashline/patcher.ts";
import { stripHashlinePrefixes } from "./hashline/prefixes.ts";

const FILEOPS_TOOL_SEARCH_PATHS = [
	"~/.local/bin",
	"~/.cargo/bin",
	"~/.zerobrew/bin",
	"/opt/zerobrew/bin",
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/pkg/env/global/bin",
	"/usr/bin",
	"/bin",
];

type EditMode = "apply_patch" | "patch" | "hashline" | "replace";
const EDIT_FRAME_MS = 120;
const EDIT_LABEL = "Editing";
const CONTEXT_PROTECTION_READ_BYTES = 50_000;
const CONTEXT_PROTECTION_READ_LABEL = "Large file read blocked";
const DEFAULT_SEARCH_RESULT_LIMIT = 200;
const DEFAULT_FIND_RESULT_LIMIT = 200;

type EditConfig = {
	mode: EditMode;
	fuzzyMatch: boolean;
	fuzzyThreshold: number;
	allowReplaceAll: boolean;
};

type ReplaceEntry = {
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
	all?: boolean;
};

type PatchEntry = {
	op: "create" | "delete" | "update";
	diff?: string;
	rename?: string;
};

type EditInput = {
	input?: string;
	path?: string;
	edits?: Array<ReplaceEntry | PatchEntry> | string;
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
	all?: boolean;
};

type NormalizedReplaceEntry = {
	oldText: string;
	newText: string;
	all?: boolean;
};

type NormalizedReplaceInput = {
	path: string;
	edits: NormalizedReplaceEntry[];
};

function largeReadGuidance(path: string, bytes: number): ToolTextResult {
	return {
		content: [
			{
				type: "text",
				text: [
					`${CONTEXT_PROTECTION_READ_LABEL}: ${path} is ${bytes.toLocaleString()} bytes.`,
					"",
					"Reading the whole file would put all bytes into the conversation.",
					'Use bounded read arguments for edit targeting, for example `ranges: ["120-180"]` or `offset` with `limit`.',
					"For analysis, summarization, filtering, or extraction, use `cg_process_file` so the file stays out of context and only your derived answer is returned.",
				].join("\n"),
			},
		],
		details: { protected: true, bytes },
	};
}

function hasBoundedReadRequest(params: { limit?: number; ranges?: string[] }, ranges: readonly LineRange[]): boolean {
	return ranges.length > 0 || (params.ranges?.length ?? 0) > 0 || params.limit !== undefined;
}

async function maybeBlockLargeWholeFileRead(
	display: string,
	absolute: string,
	params: { limit?: number; ranges?: string[] },
	ranges: readonly LineRange[],
): Promise<ToolTextResult | undefined> {
	if (hasBoundedReadRequest(params, ranges)) return undefined;
	const info = await stat(absolute);
	if (!info.isFile() || info.size <= CONTEXT_PROTECTION_READ_BYTES) return undefined;
	return largeReadGuidance(display, info.size);
}

type ToolTextResult = {
	content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
	details?: Record<string, unknown>;
};

type HighlightedSection = {
	path: string;
	rows: string[];
};

const EDIT_MODES: EditMode[] = ["apply_patch", "patch", "hashline", "replace"];
const DEFAULT_CONFIG: EditConfig = {
	mode: "apply_patch",
	fuzzyMatch: true,
	fuzzyThreshold: 0.95,
	allowReplaceAll: true,
};
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

const readToolSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the file to read (relative or absolute). Supports file:LINE or file:START-END in hashline mode.",
	}),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	ranges: Type.Optional(Type.Array(Type.String({ description: "Line range such as 10, 10-20, or L10-L20" }))),
	raw: Type.Optional(Type.Boolean({ description: "Return raw file contents without hashline headers" })),
});

const searchToolSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(
		Type.String({
			description:
				"Directory or file to search (default: current directory). Single-file paths support :LINE ranges.",
		}),
	),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of regex" })),
	context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return" })),
	ranges: Type.Optional(Type.Array(Type.String({ description: "Single-file line range such as 10 or 10-20" }))),
});

const writeToolSchema = Type.Object({
	path: Type.String({ description: "Path to write" }),
	content: Type.String({ description: "Full file content" }),
	makeExecutable: Type.Optional(Type.Boolean({ description: "Mark written file executable" })),
});

const findToolSchema = Type.Object({
	paths: Type.Optional(Type.Array(Type.String({ description: "Glob including search path" }))),
	pattern: Type.Optional(Type.String({ description: "Legacy glob pattern to match files" })),
	path: Type.Optional(Type.String({ description: "Legacy directory to search in" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files" })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect gitignore" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export const HASHLINE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "hashline", "grammar.lark"), "utf-8");
export const APPLY_PATCH_MODE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "apply-patch.lark"), "utf-8");
export const PATCH_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "patch.lark"), "utf-8");
export const REPLACE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "replace.lark"), "utf-8");

export function getConfiguredEditMode(): EditMode {
	return loadConfig().mode;
}

export function getEditFreeformToolConfig(): { description: string; grammar: string } {
	const config = loadConfig();
	return { description: modeDescription(config), grammar: modeGrammar(config.mode) };
}

const inputSchema = Type.Object({
	input: Type.String({ description: "Full edit payload in the configured edit grammar." }),
});

function normalizeMode(value: unknown): EditMode | undefined {
	return typeof value === "string" && (EDIT_MODES as string[]).includes(value) ? (value as EditMode) : undefined;
}

function loadConfig(): EditConfig {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<EditConfig>;
		const fuzzyThreshold = Number(parsed.fuzzyThreshold);
		return {
			mode:
				normalizeMode(process.env.PI_FILEOPS_EDIT_VARIANT) ??
				normalizeMode(process.env.PI_EDIT_VARIANT) ??
				normalizeMode(parsed.mode) ??
				DEFAULT_CONFIG.mode,
			fuzzyMatch:
				process.env.PI_EDIT_FUZZY === "1" || process.env.PI_EDIT_FUZZY === "true"
					? true
					: process.env.PI_EDIT_FUZZY === "0" || process.env.PI_EDIT_FUZZY === "false"
						? false
						: typeof parsed.fuzzyMatch === "boolean"
							? parsed.fuzzyMatch
							: DEFAULT_CONFIG.fuzzyMatch,
			fuzzyThreshold: Number.isFinite(Number(process.env.PI_EDIT_FUZZY_THRESHOLD))
				? Math.max(0, Math.min(1, Number(process.env.PI_EDIT_FUZZY_THRESHOLD)))
				: Number.isFinite(fuzzyThreshold)
					? Math.max(0, Math.min(1, fuzzyThreshold))
					: DEFAULT_CONFIG.fuzzyThreshold,
			allowReplaceAll:
				typeof parsed.allowReplaceAll === "boolean" ? parsed.allowReplaceAll : DEFAULT_CONFIG.allowReplaceAll,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

async function saveConfig(config: EditConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function modeParameters() {
	return inputSchema;
}

function modeGrammar(mode: EditMode): string {
	switch (mode) {
		case "apply_patch":
			return APPLY_PATCH_MODE_GRAMMAR;
		case "patch":
			return PATCH_GRAMMAR;
		case "hashline":
			return HASHLINE_GRAMMAR;
		case "replace":
			return REPLACE_GRAMMAR;
	}
}

function modeDescription(config: EditConfig): string {
	switch (config.mode) {
		case "apply_patch":
			return "Edit files using the apply_patch envelope format. For Codex this is exposed as a FREEFORM grammar-constrained custom tool.";
		case "patch":
			return "Edit one file using the patch-mode freeform grammar: *** File, then create, update diff hunks, delete, or rename entries.";
		case "hashline":
			return "Edit files using oh-my-pi hashline-style patches: ¶PATH#TAG sections, bare A B replacements, DELETE A B explicit deletes, BEFORE N/AFTER N/BOF/EOF insertion anchors, +TEXT literal rows, and &A..B repeat rows.";
		case "replace":
			return "Edit one file using the replace-mode freeform grammar: *** File, *** Old, *** New, and optional *** All blocks.";
	}
}

function absolutePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

function textToDisplayLines(text: string): string[] {
	const normalized = normalizeToLf(text);
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

type LineRange = { start: number; end: number };

function parseLineRange(raw: string): LineRange {
	const cleaned = raw
		.trim()
		.replace(/^:/, "")
		.replace(/[Ll](?=\d)/g, "");
	const match = /^([1-9]\d*)(?:\s*(?:-|\.\.)\s*([1-9]\d*))?$/.exec(cleaned);
	if (!match) throw new Error(`Invalid read line selector: ${raw}`);
	const start = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	if (end < start) throw new Error(`Invalid read line selector ${raw}: end is before start.`);
	return { start, end };
}

function splitReadPathSelector(path: string): { path: string; ranges: LineRange[] } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path, ranges: [] };
	const suffix = path.slice(colon + 1);
	if (!/^[Ll]?\d+(?:\s*(?:-|\.\.)\s*[Ll]?\d+)?(?:,\s*[Ll]?\d+(?:\s*(?:-|\.\.)\s*[Ll]?\d+)?)*$/.test(suffix)) {
		return { path, ranges: [] };
	}
	return { path: path.slice(0, colon), ranges: suffix.split(",").map(parseLineRange) };
}

function mergeLineRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function selectedLineEntries(lines: readonly string[], ranges: readonly LineRange[]): Array<[number, string]> {
	const entries: Array<[number, string]> = [];
	for (const range of ranges) {
		if (range.start > lines.length)
			throw new Error(`Line ${range.start} is beyond end of file (${lines.length} lines total)`);
		const end = Math.min(range.end, lines.length);
		for (let line = range.start; line <= end; line++) entries.push([line, lines[line - 1] ?? ""]);
	}
	return entries;
}

function lineNumberInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
	if (ranges.length === 0) return true;
	return ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
}

function firstTextContent(result: ToolTextResult): string {
	const content = result.content.find(
		(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
	);
	return content?.text ?? "";
}

function renderText(text: string): Text {
	return textComponent(text);
}

const EMPTY_VIEW = new EmptyComponent();

class BlockTextView {
	constructor(
		private readonly text: string | ((width: number) => string),
		private readonly theme: RenderTheme,
	) {}

	invalidate() {}

	render(width: number): string[] {
		const box = new Box(0, 0, this.theme.bg ? (line) => this.theme.bg?.("toolPendingBg", line) ?? line : undefined);
		box.addChild(textComponent(typeof this.text === "function" ? this.text(width) : this.text));
		return box.render(width);
	}
}

function toolTextLines(text: string): string[] {
	const lines = text.split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

function shortenDisplayPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/");
	return parts.length > 4 ? `.../${parts.slice(-4).join("/")}` : normalized;
}

function invalidArgText(theme: RenderTheme): string {
	return theme.fg("error", "[invalid]");
}

function treeLast(theme: RenderTheme): string {
	return theme.tree?.last ?? "└─";
}

function treeBranch(theme: RenderTheme): string {
	return theme.tree?.branch ?? "├─";
}

function fileIcon(theme: RenderTheme, filePath?: string): string {
	return theme.getLangIcon?.(languageFromPath(filePath)) ?? "≡";
}

function statusIcon(theme: RenderTheme, icon: "success" | "error" | "warning" | "pending"): string {
	return (
		theme.styledSymbol?.(`status.${icon}`, icon === "pending" ? "muted" : icon) ??
		(icon === "success" ? "✓" : icon === "error" ? "✗" : icon === "warning" ? "!" : "∙")
	);
}

function renderStatusHeader(
	label: string,
	theme: RenderTheme,
	rest = "",
	icon: "success" | "error" | "warning" | "pending" = "success",
): string {
	return `${statusIcon(theme, icon)} ${theme.fg("toolTitle", theme.bold(label))}${rest}`;
}

function editElapsedMs(context: { state?: Record<string, unknown> } | undefined, running: boolean): number | undefined {
	const state = context?.state;
	if (!running || !state) return undefined;
	if (typeof state.startedAtMs !== "number") state.startedAtMs = Date.now();
	return Date.now() - state.startedAtMs;
}

function scheduleEditInvalidation(
	context: { state?: Record<string, unknown>; invalidate?: () => void } | undefined,
	running: boolean,
): void {
	const state = context?.state;
	if (!state) return;
	const timer = state.elapsedTimer as ReturnType<typeof setTimeout> | undefined;
	if (!running) {
		if (timer) {
			clearTimeout(timer);
			state.elapsedTimer = undefined;
		}
		return;
	}
	if (timer || !context?.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		context.invalidate?.();
	}, EDIT_FRAME_MS);
	state.elapsedTimer.unref?.();
}

function editRunningLabel(theme: RenderTheme, elapsedMs: number | undefined): string {
	return shineText(theme, EDIT_LABEL, elapsedMs, {
		role: "accent",
		fallback: (text) => theme.fg("warning", text),
	});
}

function renderEditRunningHeader(theme: RenderTheme, elapsedMs: number | undefined, rest: string): string {
	return `${theme.fg("dim", runningFrame(elapsedMs, EDIT_FRAME_MS))} ${theme.fg("toolTitle", theme.bold(editRunningLabel(theme, elapsedMs)))}${rest}`;
}

class EditCallView {
	constructor(
		private readonly summary: EditSummary,
		private readonly theme: RenderTheme,
		private readonly running: boolean,
		private readonly elapsedMs: number | undefined,
	) {}

	invalidate() {}

	render(width: number): string[] {
		const rest = this.summary.target
			? ` ${renderEditHeaderDisplay(this.summary.target, this.summary.display, this.summary.line, this.theme)}${this.theme.fg("dim", this.summary.suffix)}`
			: ` ${invalidArgText(this.theme)}${this.theme.fg("dim", this.summary.suffix)}`;
		const header = this.running
			? renderEditRunningHeader(this.theme, this.elapsedMs, rest)
			: renderStatusHeader("Edit:", this.theme, rest);
		return renderHeaderBox(header, this.theme, "pending").render(width);
	}
}

function renderHeaderBox(text: string, theme: RenderTheme, state: "success" | "error" | "pending"): Box {
	const role = state === "success" ? "toolSuccessBg" : state === "error" ? "toolErrorBg" : "toolPendingBg";
	const box = new Box(0, 0, theme.bg ? (line) => theme.bg?.(role, line) ?? line : undefined);
	box.addChild(textComponent(text));
	return box;
}

function formatReadLineRange(args: { path?: string; offset?: number; limit?: number; ranges?: string[] }): string {
	if (args.ranges?.length) return `:${args.ranges.join(",")}`;
	const selector = typeof args.path === "string" ? splitReadPathSelector(args.path).ranges : [];
	if (selector.length > 0)
		return `:${selector.map((range) => (range.start === range.end ? range.start : `${range.start}-${range.end}`)).join(",")}`;
	if (args.offset === undefined && args.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return `:${startLine}${endLine ? `-${endLine}` : ""}`;
}

function renderNumberedRows(
	rows: readonly string[],
	theme: RenderTheme,
	limit: number,
	highlightedRows: readonly string[] = [],
): string {
	const output: string[] = [];
	const displayed = rows.slice(0, limit);
	for (const [index, row] of displayed.entries()) {
		const match = /^([ *]?)([1-9]\d*):(.*)$/.exec(row);
		if (!match) {
			output.push(theme.fg("toolOutput", row));
			continue;
		}
		const marker = match[1] === "*" ? "*" : " ";
		const lineNumber = match[2]?.padStart(3, " ") ?? "";
		const fallbackBody = theme.fg("toolOutput", match[3] ?? "");
		const body = highlightedRows[index] ?? fallbackBody;
		output.push(`${theme.fg("dim", `${marker}${lineNumber}│`)}${body}`);
	}
	if (rows.length > limit)
		output.push(
			theme.fg("muted", `... (${rows.length - limit} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	return output.join("\n");
}

type HashlineRenderSection = {
	header: string;
	path: string;
	rows: string[];
};

function parseHashlineSections(text: string): HashlineRenderSection[] {
	const sections: HashlineRenderSection[] = [];
	let current: HashlineRenderSection | undefined;
	for (const line of toolTextLines(text)) {
		const header = /^(¶(.+?)#[0-9A-Fa-f]{3})$/.exec(line);
		if (header) {
			current = { header: header[1] ?? line, path: header[2] ?? "", rows: [] };
			sections.push(current);
			continue;
		}
		if (current && line.length > 0 && !line.startsWith("[")) current.rows.push(line);
	}
	return sections;
}

function renderHashlineHeader(header: string, theme: RenderTheme): string {
	const match = /^(¶.+?)(#[0-9A-Fa-f]{3})?$/.exec(header);
	if (!match) return theme.fg("accent", header);
	return `${theme.fg("accent", match[1] ?? "")}${match[2] ? theme.fg("toolDiffAdded", match[2]) : ""}`;
}

function renderReadCall(
	params: { path?: string; offset?: number; limit?: number; ranges?: string[] },
	theme: RenderTheme,
): Text {
	const path = typeof params.path === "string" ? splitReadPathSelector(params.path).path : undefined;
	const display = path ? `${shortenDisplayPath(path)}${formatReadLineRange(params)}` : invalidArgText(theme);
	return renderText(renderStatusHeader("Read", theme, ` ${theme.fg("accent", display)}`));
}

function renderHashlineReadResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
): Text | EmptyComponent {
	if (options.isPartial) return renderText(theme.fg("warning", "Reading..."));
	if (!options.expanded) return EMPTY_VIEW;
	const sections = parseHashlineSections(firstTextContent(result));
	const section = sections[0];
	if (!section) return EMPTY_VIEW;
	const highlightedRows = Array.isArray(result.details?.highlightedRows)
		? (result.details.highlightedRows as string[])
		: [];
	return renderText(
		`${renderHashlineHeader(section.header, theme)}\n${renderNumberedRows(section.rows, theme, section.rows.length, highlightedRows)}`,
	);
}

function renderSearchCall(_params: { pattern?: unknown; path?: unknown }, _theme: RenderTheme): EmptyComponent {
	return EMPTY_VIEW;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightSearchText(text: string, pattern: string, theme: RenderTheme): string {
	if (!pattern) return theme.fg("toolOutput", text);
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "gi");
	} catch {
		regex = new RegExp(escapeRegExp(pattern), "gi");
	}
	return theme
		.fg("toolOutput", text)
		.replace(regex, (match) =>
			match.length === 0 ? match : (theme.inverse?.(match) ?? theme.fg("toolDiffAdded", match)),
		);
}

function renderSearchRow(row: string, pattern: string, theme: RenderTheme, highlightedBody?: string): string {
	const match = /^([ *]?)([1-9]\d*):(.*)$/.exec(row);
	if (!match) return theme.fg("toolOutput", row);
	const marker = match[1] === "*" ? "*" : " ";
	const lineNumber = match[2]?.padStart(3, " ") ?? "";
	const body = highlightedBody ?? highlightSearchText(match[3] ?? "", pattern, theme);
	const gutterRole = marker === "*" ? "toolDiffAdded" : "dim";
	return `${theme.fg(gutterRole, `${marker}${lineNumber}│`)}${body}`;
}
function renderSearchSections(
	sections: readonly HashlineRenderSection[],
	highlightedSections: readonly HighlightedSection[],
	theme: RenderTheme,
	expanded: boolean,
	pattern: string,
	width: number,
): string {
	const columnCount = columnCountForWidth(width, sections.length);
	const blocks: string[][] = [];
	const maxRows = expanded ? Number.POSITIVE_INFINITY : 12 * columnCount;
	let emittedRows = 0;
	for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
		if (emittedRows >= maxRows) break;
		const section = sections[sectionIndex];
		const highlighted = highlightedSections.find((candidate) => candidate.path === section.path);
		const isLastSection = sectionIndex === sections.length - 1;
		const branch = isLastSection ? treeLast(theme) : treeBranch(theme);
		const continuation = isLastSection ? "   " : `${theme.tree?.vertical ?? "│"}  `;
		const block = [
			`${theme.fg("dim", `${branch} ${fileIcon(theme, section.path)} `)}${renderHashlineHeader(section.header, theme)}`,
		];
		for (const [rowIndex, row] of section.rows.entries()) {
			if (emittedRows >= maxRows) break;
			block.push(
				`${theme.fg("dim", continuation)}${renderSearchRow(row, pattern, theme, highlighted?.rows[rowIndex])}`,
			);
			emittedRows++;
		}
		blocks.push(block);
	}
	const lines = renderColumns(blocks, width);
	const totalRows = sections.reduce((count, section) => count + section.rows.length, 0);
	if (totalRows > emittedRows)
		lines.push(
			theme.fg("muted", `... (${totalRows - emittedRows} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	return lines.join("\n");
}
function renderSearchResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	args?: { pattern?: unknown; path?: unknown },
): Text | BlockTextView | EmptyComponent {
	if (options.isPartial) return renderText(theme.fg("warning", "Searching..."));
	const text = firstTextContent(result).trim();
	const pattern = typeof args?.pattern === "string" ? args.pattern : "";
	const noMatchPath = typeof args?.path === "string" ? splitReadPathSelector(args.path).path : ".";
	if (!text.startsWith("¶"))
		return renderText(
			renderStatusHeader(
				"Search:",
				theme,
				` ${theme.fg("warning", pattern)} ${theme.fg("dim", `${text} · in ${shortenDisplayPath(noMatchPath)}`)}`,
			),
		);
	const sections = parseHashlineSections(text);
	const matchCount = sections.reduce(
		(count, section) => count + section.rows.filter((row) => row.startsWith("*")).length,
		0,
	);
	const fileText = `${sections.length} file${sections.length === 1 ? "" : "s"}`;
	const path = typeof args?.path === "string" ? splitReadPathSelector(args.path).path : sections[0]?.path;
	const header = renderStatusHeader(
		"Search:",
		theme,
		` ${theme.fg("warning", pattern)} ${theme.fg("dim", `${matchCount} match${matchCount === 1 ? "" : "es"} · ${fileText} · in ${shortenDisplayPath(path ?? ".")}`)}`,
	);
	const highlightedSections = Array.isArray(result.details?.highlightedSections)
		? (result.details.highlightedSections as HighlightedSection[])
		: [];
	return new BlockTextView((width) => {
		const body = renderSearchSections(
			sections,
			highlightedSections,
			theme,
			options.expanded ?? false,
			pattern,
			width,
		);
		return `${header}${body ? `\n${body}` : ""}`;
	}, theme);
}

function renderFindCall(
	_params: { paths?: string[]; pattern?: unknown; path?: unknown },
	_theme: RenderTheme,
): EmptyComponent {
	return EMPTY_VIEW;
}

function renderFindResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	args?: { paths?: string[]; pattern?: unknown; path?: unknown },
): Text | BlockTextView {
	if (options.isPartial) return renderText(theme.fg("warning", "Finding files..."));
	const output = firstTextContent(result).trim();
	if (/not found on PATH|failed|error/i.test(output.split("\n")[0] ?? ""))
		return renderText(theme.fg("error", output));
	const files = toolTextLines(output).filter((line) => line && !line.startsWith("No files"));
	const target = Array.isArray(args?.paths) ? args.paths.join(", ") : String(args?.pattern ?? "");
	const where = Array.isArray(args?.paths) ? dirname(args.paths[0] ?? ".") : String(args?.path ?? ".");
	const header = renderStatusHeader(
		"Find:",
		theme,
		` ${theme.fg("warning", shortenDisplayPath(target))} ${theme.fg("dim", `${files.length} file${files.length === 1 ? "" : "s"} · in ${shortenDisplayPath(where)}`)}`,
	);
	return new BlockTextView((width) => {
		const columnCount = columnCountForWidth(width, files.length);
		const shown = files.slice(0, options.expanded ? files.length : 20 * columnCount);
		const blocks = shown.map((file, index) => [
			`${theme.fg("dim", `${index === shown.length - 1 ? treeLast(theme) : treeBranch(theme)} ${fileIcon(theme, file)} `)}${theme.fg("toolOutput", shortenDisplayPath(file))}`,
		]);
		const body = renderColumns(blocks, width).join("\n");
		const more =
			files.length > shown.length
				? `\n${theme.fg("muted", `... (${files.length - shown.length} more files, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
				: "";
		return `${header}${body ? `\n${body}${more}` : ""}`;
	}, theme);
}
function renderWriteCall(
	params: { path?: string; content?: string },
	theme: RenderTheme,
	options: { expanded?: boolean } = {},
): Text {
	const path = params.path ? shortenDisplayPath(params.path) : invalidArgText(theme);
	if (typeof params.content !== "string") {
		return renderText(
			`${renderStatusHeader("Write:", theme, ` ${theme.fg("accent", path)}`)}\n\n${theme.fg("error", "[invalid content arg - expected string]")}`,
		);
	}
	const rows = params.content.split("\n").map((line, index) => `${index + 1}:${line}`);
	const bodyRows = params.content.split("\n");
	const limit = options.expanded ? rows.length : 12;
	const highlightedRows = highlightCodeRowsSync(params.path, bodyRows.slice(0, limit));
	const lineCount = rows.length;
	const header = renderStatusHeader(
		"Write:",
		theme,
		` ${fileIcon(theme, params.path)} ${theme.fg("accent", path)} ${theme.fg("dim", `· ${lineCount} lines`)}`,
	);
	return renderText(`${header}\n\n${renderNumberedRows(rows, theme, limit, highlightedRows)}`);
}

function renderWriteResult(
	result: ToolTextResult,
	options: { isPartial?: boolean },
	theme: RenderTheme,
): Text | EmptyComponent {
	if (options.isPartial) return renderText(theme.fg("warning", "Writing..."));
	const text = firstTextContent(result);
	return /error/i.test(text) ? renderText(`\n${theme.fg("error", text)}`) : EMPTY_VIEW;
}

type EditSummary = { target?: string; display?: string; line?: number; suffix: string };

function shortenHashlineHeader(header: string): string {
	const match = /^¶(.+?)(#[0-9A-Fa-f]{3})?$/.exec(header);
	if (!match) return shortenDisplayPath(header);
	return `¶${shortenDisplayPath(match[1] ?? "")}${match[2] ?? ""}`;
}

function summarizeEditInput(input: unknown, mode: EditMode): EditSummary {
	if (typeof input !== "string") return { suffix: ` (${mode})` };
	const hashline = input.match(/^(¶([^#\n]+)(?:#[0-9A-Fa-f]{3})?)$/m);
	const range = input.match(/^([1-9]\d*)\s+[1-9]\d*$/m);
	if (hashline) {
		return {
			target: hashline[2],
			display: shortenHashlineHeader(hashline[1] ?? ""),
			line: range ? Number(range[1]) : undefined,
			suffix: "",
		};
	}
	const file = input.match(/^\*\*\* (?:File|Add File|Update File|Delete File):\s*(.+)$/m);
	if (file) return { target: file[1], suffix: "" };
	return { suffix: ` (${mode})` };
}

function renderEditHeaderDisplay(
	target: string,
	display: string | undefined,
	line: number | undefined,
	theme: RenderTheme,
) {
	const lineSuffix = line ? theme.fg("warning", `:${line}`) : "";
	const renderedTarget = display?.startsWith("¶")
		? renderHashlineHeader(display, theme)
		: theme.fg("accent", display ?? shortenDisplayPath(target));
	return `${fileIcon(theme, target)} ${renderedTarget}${lineSuffix}`;
}

function renderEditCall(
	summary: EditSummary,
	theme: RenderTheme,
	context?: { state?: Record<string, unknown>; isPartial?: boolean; invalidate?: () => void },
): EditCallView {
	const running = context?.isPartial === true;
	scheduleEditInvalidation(context, running);
	return new EditCallView(summary, theme, running, editElapsedMs(context, running));
}
function renderEditResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
) {
	if (options.isPartial) return renderText(theme.fg("warning", "Editing..."));
	const text = firstTextContent(result);
	if (/rejected|error/i.test(text.split("\n")[0] ?? "")) return renderText(`\n${theme.fg("error", text)}`);
	const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
	if (!diff) return options.expanded ? renderText(theme.fg("toolOutput", text)) : renderText("");
	const rows = Array.isArray(result.details?.highlightedDiffRows)
		? (result.details.highlightedDiffRows as DiffRenderRow[])
		: undefined;
	const resultHeaders = new Map<string, string>();
	if (Array.isArray(result.details?.results)) {
		for (const section of result.details.results as Array<{ path?: unknown; header?: unknown }>) {
			if (typeof section.path === "string" && typeof section.header === "string") {
				resultHeaders.set(section.path, shortenHashlineHeader(section.header));
			}
		}
	}
	const renderHashlineEditSectionHeader: DiffSectionHeaderRenderer = (target, line, theme) => {
		return renderStatusHeader(
			"Edit:",
			theme,
			` ${renderEditHeaderDisplay(target, resultHeaders.get(target), line, theme)}`,
		);
	};
	return new EditDiffView(diff, rows, options.expanded ?? false, theme, renderHashlineEditSectionHeader);
}

function splitGlobSearchRoot(cwd: string, pattern: string): { root: string; glob: string } {
	const normalized = pattern.replace(/\\/g, "/");
	const firstGlob = normalized.search(/[*?[{]/);
	if (firstGlob === -1) return { root: cwd, glob: normalized };
	const slashBeforeGlob = normalized.lastIndexOf("/", firstGlob);
	if (slashBeforeGlob === -1) return { root: cwd, glob: normalized };
	const rootText = normalized.slice(0, slashBeforeGlob) || "/";
	const glob = normalized.slice(slashBeforeGlob + 1);
	return { root: absolutePath(cwd, rootText), glob };
}
function stripHashlineDisplayPrefixes(content: string): { text: string; stripped: boolean } {
	const lines = normalizeToLf(content).split("\n");
	const stripped = stripHashlinePrefixes(lines);
	if (stripped === lines || stripped.join("\n") === lines.join("\n")) return { text: content, stripped: false };
	return { text: stripped.join("\n"), stripped: true };
}

function prepareEditArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const raw = input as Record<string, unknown>;
	const path = typeof raw.path === "string" ? raw.path : typeof raw.file_path === "string" ? raw.file_path : undefined;
	let edits = raw.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {}
	}

	const legacyOld = typeof raw.oldText === "string" ? raw.oldText : raw.old_text;
	const legacyNew = typeof raw.newText === "string" ? raw.newText : raw.new_text;
	if ((typeof legacyOld === "string" || typeof legacyNew === "string") && !Array.isArray(edits)) {
		edits = [{ old_text: legacyOld, new_text: legacyNew, all: raw.all }];
	}

	return { ...raw, path, edits };
}

function normalizeReplaceInput(input: EditInput): NormalizedReplaceInput {
	const prepared = prepareEditArguments(input) as EditInput;
	if (!prepared.path) throw new Error("edit replace mode requires path.");
	if (!Array.isArray(prepared.edits) || prepared.edits.length === 0) {
		throw new Error("edit replace mode requires at least one replacement in edits[].");
	}
	return {
		path: prepared.path,
		edits: (prepared.edits as ReplaceEntry[]).map((edit, index) => {
			const oldText = typeof edit.oldText === "string" ? edit.oldText : edit.old_text;
			const newText = typeof edit.newText === "string" ? edit.newText : edit.new_text;
			if (typeof oldText !== "string") throw new Error(`edit edits[${index}].old_text is required.`);
			if (typeof newText !== "string") throw new Error(`edit edits[${index}].new_text is required.`);
			if (oldText.length === 0) throw new Error(`edit edits[${index}].old_text must not be empty.`);
			return { oldText, newText, all: edit.all };
		}),
	};
}

function toBuiltInInput(input: NormalizedReplaceInput): {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
} {
	return {
		path: input.path,
		edits: input.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
	};
}

function stripBom(text: string): { bom: string; text: string } {
	return text.charCodeAt(0) === 0xfeff ? { bom: text.slice(0, 1), text: text.slice(1) } : { bom: "", text };
}

function detectLineEnding(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function firstChangedLine(before: string, after: string): number | undefined {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	const max = Math.max(beforeLines.length, afterLines.length);
	for (let index = 0; index < max; index++) {
		if (beforeLines[index] !== afterLines[index]) return index + 1;
	}
	return undefined;
}

function replaceAllLiteral(text: string, oldText: string, newText: string): { text: string; count: number } {
	const parts = text.split(oldText);
	if (parts.length === 1) return { text, count: 0 };
	return { text: parts.join(newText), count: parts.length - 1 };
}

async function executeReplace(
	cwd: string,
	input: EditInput,
	config: EditConfig,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: EditToolDetails }> {
	const normalized = normalizeReplaceInput(input);
	if (!normalized.edits.some((edit) => edit.all)) {
		return createEditToolDefinition(cwd).execute("edit", toBuiltInInput(normalized), signal);
	}
	if (!config.allowReplaceAll) throw new Error("edit replace mode has all: true disabled by /edit-config.");

	const target = absolutePath(cwd, normalized.path);
	return withFileMutationQueue(target, async () => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const raw = await readFile(target, "utf-8");
		const { bom, text } = stripBom(raw);
		const lineEnding = detectLineEnding(text);
		const before = normalizeToLf(text);
		let current = before;
		let total = 0;

		for (const edit of normalized.edits) {
			const oldText = normalizeToLf(edit.oldText);
			const newText = normalizeToLf(edit.newText);
			if (edit.all) {
				const result = replaceAllLiteral(current, oldText, newText);
				if (result.count === 0) throw new Error(`Could not find old_text in ${normalized.path}.`);
				current = result.text;
				total += result.count;
				continue;
			}

			const first = current.indexOf(oldText);
			if (first === -1) throw new Error(`Could not find old_text in ${normalized.path}.`);
			if (current.indexOf(oldText, first + oldText.length) !== -1) {
				throw new Error(`Found multiple occurrences in ${normalized.path}. Add more context or set all: true.`);
			}
			current = `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
			total += 1;
		}

		if (current === before) throw new Error(`Edits to ${normalized.path} resulted in no changes being made.`);
		await writeFile(target, bom + restoreLineEndings(current, lineEnding), "utf-8");

		const patch = createTwoFilesPatch(normalized.path, normalized.path, before, current, "", "", { context: 3 });
		const highlightedDiffRows = await buildHighlightedDiffRows(patch);
		return {
			content: [
				{
					type: "text",
					text: `Successfully replaced ${total} occurrence${total === 1 ? "" : "s"} in ${normalized.path}.`,
				},
			],
			details: { diff: patch, patch, highlightedDiffRows, firstChangedLine: firstChangedLine(before, current) },
		};
	});
}

function patchModeToApplyPatch(input: EditInput): string {
	if (!input.path) throw new Error("edit patch mode requires path.");
	if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edit patch mode requires edits[].");
	const lines = ["*** Begin Patch"];
	for (const edit of input.edits as PatchEntry[]) {
		if (edit.op === "create") {
			lines.push(`*** Add File: ${input.path}`);
			lines.push(
				...(edit.diff ?? "")
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.map((line) => `+${line}`),
			);
			continue;
		}
		if (edit.op === "delete") {
			lines.push(`*** Delete File: ${input.path}`);
			continue;
		}
		if (edit.op === "update") {
			lines.push(`*** Update File: ${input.path}`);
			if (edit.rename) lines.push(`*** Move to: ${edit.rename}`);
			lines.push((edit.diff ?? "").replace(/\r\n?/g, "\n").trimEnd());
			continue;
		}
		throw new Error(`Unsupported edit patch op: ${(edit as { op?: unknown }).op}`);
	}
	lines.push("*** End Patch");
	return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
}

function parsePatchInput(input: string): EditInput {
	const edits: PatchEntry[] = [];
	let path: string | undefined;
	let current: PatchEntry | undefined;
	const flush = () => {
		if (current) edits.push(current);
		current = undefined;
	};
	const lines = normalizeToLf(input).split("\n");
	if (lines.at(-1) === "") lines.pop();

	for (const line of lines) {
		if (line.trim() === "" && !current) continue;
		if (line.startsWith("*** File: ")) {
			flush();
			path = line.slice("*** File: ".length).trim();
			continue;
		}
		if (line === "*** Create") {
			flush();
			current = { op: "create", diff: "" };
			continue;
		}
		if (line === "*** Update") {
			flush();
			current = { op: "update", diff: "" };
			continue;
		}
		if (line === "*** Delete") {
			flush();
			current = { op: "delete" };
			continue;
		}
		if (line.startsWith("*** Rename to: ")) {
			if (!current || current.op !== "update") {
				flush();
				current = { op: "update", diff: "" };
			}
			current.rename = line.slice("*** Rename to: ".length).trim();
			continue;
		}
		if (!current || current.op === "delete") throw new Error(`patch mode line outside entry: ${line}`);
		if (current.op === "create") {
			if (!line.startsWith("+")) throw new Error(`create lines must start with '+': ${line}`);
			current.diff = `${current.diff ?? ""}${line.slice(1)}\n`;
		} else {
			current.diff = `${current.diff ?? ""}${line}\n`;
		}
	}
	flush();
	if (!path) throw new Error("patch mode requires a *** File: header.");
	return { path, edits };
}

function parseReplaceInput(input: string): EditInput {
	const edits: ReplaceEntry[] = [];
	let path: string | undefined;
	let current: ReplaceEntry | undefined;
	let bucket: "old" | "new" | undefined;
	const flush = () => {
		if (current) edits.push(current);
		current = undefined;
		bucket = undefined;
	};

	for (const line of normalizeToLf(input).split("\n")) {
		if (line.trim() === "") continue;
		if (line.startsWith("*** File: ")) {
			flush();
			path = line.slice("*** File: ".length).trim();
			continue;
		}
		if (line === "*** Old") {
			flush();
			current = { old_text: "", new_text: "" };
			bucket = "old";
			continue;
		}
		if (line === "*** New") {
			if (!current) throw new Error("replace mode has *** New before *** Old.");
			bucket = "new";
			continue;
		}
		if (line === "*** All") {
			if (!current) throw new Error("replace mode has *** All before replacement.");
			current.all = true;
			continue;
		}
		if (!current || !bucket || !line.startsWith("|")) {
			throw new Error(`replace mode payload line must start with '|': ${line}`);
		}
		const key = bucket === "old" ? "old_text" : "new_text";
		current[key] = `${current[key] ?? ""}${line.slice(1)}\n`;
	}
	flush();
	if (!path) throw new Error("replace mode requires a *** File: header.");
	for (const edit of edits) {
		if (edit.old_text?.endsWith("\n")) edit.old_text = edit.old_text.slice(0, -1);
		if (edit.new_text?.endsWith("\n")) edit.new_text = edit.new_text.slice(0, -1);
	}
	return { path, edits };
}

async function runApplyPatch(cwd: string, input: string, signal?: AbortSignal) {
	const result = await runExternalCommand("ct", ["apply-patch", "--cwd", cwd], cwd, { signal, input });
	return {
		content: [{ type: "text", text: result.stdout || result.stderr || "edit applied" }],
		details: { diff: "", patch: "" },
	};
}

class CwdHashlineFilesystem extends Filesystem {
	constructor(private readonly cwd: string) {
		super();
	}

	#absolute(path: string): string {
		return absolutePath(this.cwd, path);
	}

	async readText(path: string): Promise<string> {
		try {
			return await readFile(this.#absolute(path), "utf-8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new NotFoundError(path, error);
			}
			throw error;
		}
	}

	async preflightWrite(path: string): Promise<void> {
		await mkdir(dirname(this.#absolute(path)), { recursive: true });
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		const absolute = this.#absolute(path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, content, "utf-8");
		return { text: content };
	}

	canonicalPath(path: string): string {
		return this.#absolute(path);
	}
}

async function withHashlineMutationQueues<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const unique = [...new Set(paths)].sort();
	const run = (index: number): Promise<T> => {
		const path = unique[index];
		if (path === undefined) return fn();
		return withFileMutationQueue(path, () => run(index + 1));
	};
	return run(0);
}

async function executeHashline(cwd: string, input: string) {
	const patch = Patch.parse(input, { cwd });
	if (patch.sections.length === 0) throw new Error("hashline mode requires at least one ¶PATH section.");
	const fs = new CwdHashlineFilesystem(cwd);
	const patcher = new Patcher({ fs, snapshots: HASHLINE_SNAPSHOTS });
	const targets = patch.sections.map((section) => fs.canonicalPath(section.path));
	const applied = await withHashlineMutationQueues(targets, () => patcher.apply(patch));
	const diffs = applied.sections.map((section) =>
		createTwoFilesPatch(section.path, section.path, section.before, section.after, "", "", { context: 3 }),
	);
	const diff = diffs.join("\n");
	const noops = applied.sections.filter((section) => section.op === "noop");
	const warnings = applied.sections.flatMap((section) => section.warnings);
	const firstLine = applied.sections.find((section) => section.firstChangedLine !== undefined)?.firstChangedLine;
	const preview = buildCompactDiffPreview(diff).preview;
	const highlightedDiffRows = await buildHighlightedDiffRows(diff);
	return {
		content: [
			{
				type: "text",
				text: [
					`Applied hashline edit to ${applied.sections.length} section${applied.sections.length === 1 ? "" : "s"}.`,
					...applied.sections.map((section) => `${section.op}: ${section.header}`),
					...(noops.length > 0 ? [`No-op sections: ${noops.map((section) => section.path).join(", ")}`] : []),
					...(warnings.length > 0 ? ["", "Warnings:", ...warnings.map((warning) => `- ${warning}`)] : []),
				].join("\n"),
			},
		],
		details: {
			diff,
			patch: diff,
			highlightedDiffRows,
			preview,
			results: applied.sections,
			firstChangedLine: firstLine,
		},
	};
}

async function executeByMode(cwd: string, params: EditInput, config: EditConfig, signal?: AbortSignal) {
	switch (config.mode) {
		case "apply_patch":
			if (typeof params.input !== "string") throw new Error("edit apply_patch mode requires input.");
			return runApplyPatch(cwd, params.input, signal);
		case "patch":
			return runApplyPatch(
				cwd,
				patchModeToApplyPatch(
					typeof params.input === "string"
						? parsePatchInput(params.input)
						: (prepareEditArguments(params) as EditInput),
				),
				signal,
			);
		case "hashline":
			if (typeof params.input !== "string") throw new Error("edit hashline mode requires input.");
			return executeHashline(cwd, params.input);
		case "replace":
			return executeReplace(
				cwd,
				typeof params.input === "string" ? parseReplaceInput(params.input) : params,
				config,
				signal,
			);
	}
}

function registerHashlineWorkflowTools(pi: ExtensionAPI, getConfig: () => EditConfig) {
	const cwd = process.cwd();
	const baseRead = createReadToolDefinition(cwd);
	const baseFind = createFindToolDefinition(cwd);
	const baseWrite = createWriteToolDefinition(cwd);

	pi.registerTool({
		...baseRead,
		name: "read",
		description:
			"Read a text file. In hashline edit mode, returns ¶PATH#TAG plus LINE:TEXT rows that can be targeted by hashline edits.",
		parameters: readToolSchema,
		renderShell: "self",
		renderCall(params, theme) {
			return renderReadCall(params, theme);
		},
		renderResult(result, options, theme) {
			return renderHashlineReadResult(result as ToolTextResult, options, theme);
		},
		async execute(
			toolCallId,
			params: { path: string; offset?: number; limit?: number; ranges?: string[]; raw?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			const callCwd = ctx?.cwd ?? cwd;
			const selector = splitReadPathSelector(params.path);
			const selectedPath = selector.path;
			const absolute = absolutePath(callCwd, selectedPath);
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList) => rangeList.split(",").map(parseLineRange)),
			];
			const largeReadBlock = await maybeBlockLargeWholeFileRead(
				displayPath(callCwd, absolute),
				absolute,
				params,
				explicitRanges,
			);
			if (largeReadBlock) return largeReadBlock;
			if (getConfig().mode !== "hashline") {
				return baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
			}
			const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
			const text = normalizeToLf(rawText);
			if (params.raw && explicitRanges.length === 0 && params.limit === undefined)
				return { content: [{ type: "text", text }] };
			const allLines = textToDisplayLines(text);
			if (explicitRanges.length > 0) {
				const ranges = mergeLineRanges(explicitRanges);
				const entries = selectedLineEntries(allLines, ranges);
				if (params.raw) return { content: [{ type: "text", text: entries.map(([, line]) => line).join("\n") }] };
				const wholeFile = ranges.length === 1 && ranges[0]?.start === 1 && ranges[0].end >= allLines.length;
				const tag = wholeFile
					? recordHashlineContiguous(absolute, 1, allLines, text)
					: recordHashlineSparse(absolute, entries);
				const outputRows = entries.map(([lineNumber, line]) => `${lineNumber}:${line}`);
				const output = [formatHashlineHeader(displayPath(callCwd, absolute), tag), ...outputRows].join("\n");
				const visibleEntries = entries.slice(0, 80);
				const highlightedRows = await highlightCodeRows(
					selectedPath,
					visibleEntries.map(([, line]) => line),
				);
				return {
					content: [{ type: "text", text: output }],
					details: { hashlineTag: tag, ranges, highlightedRows },
				};
			}
			const startLine = Math.max(1, Math.floor(params.offset ?? 1));
			if (startLine > allLines.length)
				throw new Error(`Offset ${startLine} is beyond end of file (${allLines.length} lines total)`);
			const endExclusive =
				params.limit === undefined
					? allLines.length
					: Math.min(allLines.length, startLine - 1 + Math.max(1, params.limit));
			const selected = allLines.slice(startLine - 1, endExclusive);
			if (params.raw) return { content: [{ type: "text", text: selected.join("\n") }] };
			const wholeFile = startLine === 1 && endExclusive === allLines.length;
			const tag = recordHashlineContiguous(
				absolute,
				wholeFile ? 1 : startLine,
				wholeFile ? allLines : selected,
				wholeFile ? text : undefined,
			);
			let output = `${formatHashlineHeader(displayPath(callCwd, absolute), tag)}\n${formatNumberedLines(selected.join("\n"), startLine)}`;
			if (endExclusive < allLines.length) {
				const remaining = allLines.length - endExclusive;
				const lineWord = remaining === 1 ? "line" : "lines";
				output += `\n\n[${remaining} more ${lineWord} in file. Use offset=${endExclusive + 1} or path:${endExclusive + 1}-${allLines.length} to continue.]`;
			}
			const visibleSelected = selected.slice(0, 80);
			return {
				content: [{ type: "text", text: output }],
				details: { hashlineTag: tag, highlightedRows: await highlightCodeRows(selectedPath, visibleSelected) },
			};
		},
	});

	pi.registerTool({
		name: "search",
		label: "search",
		description:
			"Search file contents. In hashline edit mode, matching lines are grouped under ¶PATH#TAG headers with LINE:TEXT rows.",
		promptSnippet: "Search file contents and return hashline-editable matches",
		promptGuidelines: [
			"Use search for file-content searches when it is active; use read when you already know the path.",
		],
		parameters: searchToolSchema,
		renderShell: "self",
		renderCall(params, theme) {
			return renderSearchCall(params, theme);
		},
		renderResult(result, options, theme, context) {
			return renderSearchResult(result as ToolTextResult, options, theme, context.args as any);
		},
		async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
			const callCwd = ctx?.cwd ?? cwd;
			const selector = params.path ? splitReadPathSelector(String(params.path)) : { path: undefined, ranges: [] };
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList: string) => rangeList.split(",").map(parseLineRange)),
			];
			const searchPath = selector.path;
			const args = ["--line-number", "--color=never", "--hidden", "--no-heading"];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.literal) args.push("--fixed-strings");
			if (params.glob) args.push("--glob", String(params.glob));
			if (params.context && params.context > 0) args.push("-C", String(Math.max(0, Math.floor(params.context))));
			const resultLimit = Math.max(1, Math.min(1000, Number(params.limit ?? DEFAULT_SEARCH_RESULT_LIMIT)));
			const rgMaxCount = params.limit === undefined ? resultLimit + 1 : resultLimit;
			args.push("--max-count", String(rgMaxCount));
			args.push("--", String(params.pattern), searchPath ? String(searchPath) : ".");
			const result = await runExternalCommand("rg", args, callCwd, {
				signal,
				allowNonZero: true,
				extraSearchPaths: FILEOPS_TOOL_SEARCH_PATHS,
			});
			if (result.exitCode === 1 || result.stdout.trim().length === 0) {
				return { content: [{ type: "text", text: "No matches found" }] };
			}
			const byFile = new Map<string, Map<number, { text: string; isMatch: boolean }>>();
			for (const line of result.stdout.replace(/\r\n?/g, "\n").split("\n")) {
				if (!line.trim() || line === "--") continue;
				const match = /^(.*?)([:-])([1-9]\d*)([:-])(.*)$/.exec(line);
				const singleFileMatch = !match && searchPath ? /^([1-9]\d*)([:-])(.*)$/.exec(line) : undefined;
				if (!match && !singleFileMatch) continue;
				const absolute = match ? absolutePath(callCwd, match[1]) : absolutePath(callCwd, String(searchPath));
				const lineNumber = Number(match ? match[3] : singleFileMatch?.[1]);
				if (!lineNumberInRanges(lineNumber, explicitRanges)) continue;
				const isMatch = (match ? match[2] : singleFileMatch?.[2]) === ":";
				const fileLines = byFile.get(absolute) ?? new Map<number, { text: string; isMatch: boolean }>();
				fileLines.set(lineNumber, { text: match ? match[5] : (singleFileMatch?.[3] ?? ""), isMatch });
				byFile.set(absolute, fileLines);
			}
			if (byFile.size === 0) return { content: [{ type: "text", text: "No matches found in selected ranges" }] };
			const sections: string[] = [];
			const highlightedSections: HighlightedSection[] = [];
			let emittedRows = 0;
			let truncatedSearch = false;
			for (const [absolute, sparse] of [...byFile.entries()].sort((left, right) =>
				left[0].localeCompare(right[0]),
			)) {
				const ordered = [...sparse.entries()].sort((left, right) => left[0] - right[0]);
				const cappedOrdered = ordered.slice(0, Math.max(0, resultLimit - emittedRows));
				emittedRows += cappedOrdered.length;
				if (cappedOrdered.length < ordered.length) truncatedSearch = true;
				if (cappedOrdered.length === 0) continue;
				const display = displayPath(callCwd, absolute);
				const tag = recordHashlineSparse(
					absolute,
					cappedOrdered.map(([lineNumber, entry]) => [lineNumber, entry.text] as const),
				);
				const visibleOrdered = cappedOrdered.slice(0, 80);
				const highlightedRows = (
					await highlightCodeRows(
						display,
						visibleOrdered.map(([, entry]) => entry.text),
					)
				).map((row, index) =>
					visibleOrdered[index]?.[1].isMatch ? highlightSearchMatches(row, String(params.pattern)) : row,
				);
				highlightedSections.push({ path: display, rows: highlightedRows });
				sections.push(
					[
						formatHashlineHeader(display, tag),
						...cappedOrdered.map(
							([lineNumber, entry]) => `${entry.isMatch ? "*" : " "}${lineNumber}:${entry.text}`,
						),
					].join("\n"),
				);
			}
			if (truncatedSearch) {
				sections.push(
					[
						`[Search results truncated at ${resultLimit} rows.]`,
						"Use a narrower path/glob/ranges, or index the source with `cg_index` and query it with `cg_search`.",
					].join("\n"),
				);
			}
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: { highlightedSections } };
		},
	});

	pi.registerTool({
		...baseFind,
		name: "find",
		description: "Find files by glob/path. Accepts either {pattern,path} or oh-my-pi-style {paths:[...]} inputs.",
		promptGuidelines: ["Use find for file discovery by glob or path when it is active."],
		parameters: findToolSchema,
		renderShell: "self",
		renderCall(params, theme) {
			return renderFindCall(params, theme);
		},
		renderResult(result, options, theme, context) {
			return renderFindResult(result as ToolTextResult, options, theme, context.args as any);
		},
		async execute(toolCallId, params: any, signal, onUpdate, ctx) {
			if (!Array.isArray(params.paths)) return baseFind.execute(toolCallId, params, signal, onUpdate, ctx);
			const callCwd = ctx?.cwd ?? cwd;
			const limit = Math.max(1, Math.min(1000, Number(params.limit ?? DEFAULT_FIND_RESULT_LIMIT)));
			const outputs: string[] = [];
			for (const pattern of params.paths) {
				const search = splitGlobSearchRoot(callCwd, String(pattern));
				const rootStat = await stat(search.root).catch(() => undefined);
				if (!rootStat?.isDirectory()) continue;
				const args = ["--files", "--color=never"];
				if (!params.gitignore) args.push("--no-ignore");
				if (params.hidden) args.push("--hidden");
				args.push("--glob", search.glob);
				const result = await runExternalCommand("rg", args, search.root, {
					signal,
					allowNonZero: true,
					extraSearchPaths: FILEOPS_TOOL_SEARCH_PATHS,
				});
				outputs.push(
					...result.stdout
						.split("\n")
						.filter(Boolean)
						.map((file) => displayPath(callCwd, absolutePath(search.root, file))),
				);
			}
			const allUnique = [...new Set(outputs)].sort((left, right) => left.localeCompare(right));
			const unique = allUnique.slice(0, limit);
			const truncatedFind = params.limit === undefined && allUnique.length > limit;
			const text =
				unique.length === 0
					? "No files found matching pattern"
					: [
							...unique,
							...(truncatedFind
								? [
										`[Find results truncated at ${limit} files. Use a narrower glob/path, or index sources with cg_index and query them with cg_search.]`,
									]
								: []),
						].join("\n");
			return {
				content: [{ type: "text", text }],
			};
		},
	});

	pi.registerTool({
		...baseWrite,
		name: "write",
		description:
			"Write a file. In hashline edit mode, copied ¶PATH#TAG and LINE: prefixes are stripped from content before writing.",
		parameters: writeToolSchema,
		renderShell: "self",
		renderCall(params, theme, context) {
			return renderWriteCall(params, theme, context);
		},
		renderResult(result, options, theme) {
			return renderWriteResult(result as ToolTextResult, options, theme);
		},
		async execute(
			toolCallId,
			params: { path: string; content: string; makeExecutable?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			if (getConfig().mode !== "hashline") return baseWrite.execute(toolCallId, params, signal, onUpdate, ctx);
			const callCwd = ctx?.cwd ?? cwd;
			const stripped = stripHashlineDisplayPrefixes(params.content);
			const absolute = absolutePath(callCwd, params.path);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, stripped.text, "utf-8");
			if (params.makeExecutable || stripped.text.startsWith("#!")) await chmod(absolute, 0o755);
			HASHLINE_SNAPSHOTS.invalidate(absolute);
			const result: ToolTextResult = {
				content: [{ type: "text", text: `Wrote ${params.path}` }],
				details: {},
			};
			if (stripped.stripped) {
				const first = result.content.find(
					(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
				);
				if (first) first.text += "\nNote: auto-stripped hashline display prefixes from content before writing.";
			}
			return result;
		},
	});
}

function formatConfig(config: EditConfig): string {
	return [
		`mode: ${config.mode}`,
		`fuzzyMatch: ${config.fuzzyMatch}`,
		`fuzzyThreshold: ${config.fuzzyThreshold}`,
		`allowReplaceAll: ${config.allowReplaceAll}`,
	].join("\n");
}

export default function fileopsExtension(pi: ExtensionAPI) {
	let config = loadConfig();

	const registerEditTool = () => {
		const current = config;
		pi.registerTool({
			name: "edit",
			label: "edit",
			description: modeDescription(current),
			promptSnippet: "Edit files using the currently configured edit mode.",
			promptGuidelines: [
				"Use edit for manual file edits when it is active; follow the tool description and grammar for the current edit mode.",
			],
			parameters: modeParameters(),
			renderShell: "self",
			prepareArguments: prepareEditArguments,
			renderCall(params, theme, context) {
				const summary = summarizeEditInput((params as { input?: unknown }).input, current.mode);
				return renderEditCall(summary, theme, context as any);
			},
			renderResult(result, options, theme) {
				return renderEditResult(result as ToolTextResult, options, theme);
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return executeByMode(ctx.cwd, params as EditInput, current, signal);
			},
		});
	};

	registerEditTool();
	registerHashlineWorkflowTools(pi, () => config);

	pi.registerCommand("edit-config", {
		description: "Configure edit mode: apply_patch, patch, hashline, or replace",
		getArgumentCompletions: (prefix: string) => {
			const normalizedPrefix = prefix.trimStart();
			const items = EDIT_MODES.filter((mode) => mode.startsWith(normalizedPrefix)).map((mode) => ({
				value: mode,
				label: mode,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = normalizeMode(args.trim());
			const mode =
				requested ??
				(await ctx.ui.select(
					`Edit mode\n\n${formatConfig(config)}`,
					EDIT_MODES.map((mode) => (mode === config.mode ? `${mode} (current)` : mode)),
				));
			const normalized = normalizeMode(String(mode).replace(/\s+\(current\)$/, ""));
			if (!normalized) {
				ctx.ui.notify(`Usage: /edit-config ${EDIT_MODES.join("|")}`, "error");
				return;
			}
			config = { ...config, mode: normalized };
			await saveConfig(config);
			registerEditTool();
			ctx.ui.notify(`edit mode set to ${config.mode}\n${CONFIG_PATH}`, "info");
		},
	});
}
