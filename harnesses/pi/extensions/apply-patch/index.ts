// @ts-nocheck
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionContext, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BundledLanguage, BundledTheme } from "shiki";
import { Type } from "typebox";
import { getConfiguredEditMode, getEditFreeformToolConfig } from "../fileops/index.ts";
import { runCommand as runExternalCommand } from "../shared/command-runner.ts";
import { nf, title } from "../shared/ct-render.ts";
import { resolveInlineLanguageForPath, resolveShikiLanguageForPath } from "../shared/path-language";
import {
	clampAnsiLine,
	EmptyComponent,
	padToVisibleWidth,
	paintAnsiBackgroundRow,
	runningFrame,
	shineText,
	textComponent,
} from "../shared/tui";

import { highlightWgslAnsi, registerWgslHighlightLanguage } from "../shared/wgsl-highlight.ts";
import { registerApplyPatchFreeformProvider } from "./freeform-codex.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

const APPLY_PATCH_USAGE_ENTRY = "apply_patch_usage";
const APPLY_PATCH_TOOL_NAME = "apply_patch";

registerWgslHighlightLanguage();

export const APPLY_PATCH_GRAMMAR = `start: begin_patch preamble? hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
preamble: (intent | environment_id)+
intent: "*** Intent: " intent_text LF
environment_id: "*** Environment ID: " filename LF

hunk: add_hunk | delete_hunk | update_hunk | move_hunk | replace_all_hunk | update_scope_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
move_hunk: "*** Move File: " move_spec LF
replace_all_hunk: "*** Replace All In File: " filename LF expect_replacements replace_line+
update_scope_hunk: "*** Update Scope: " filename LF scope_change+

filename: /(.+)/
intent_text: /(.+)/
move_spec: /(.+) -> (.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ lines " /([0-9]+-[0-9]+)/ | "@@ " /(.+)/) LF
scope_change: "@@ " /(.+)/ LF change_line+ eof_line?
change_line: ("+" | "-" | " ") /(.*)/ LF
expect_replacements: "*** Expect Replacements: " /[0-9]+/ LF
replace_line: ("+" | "-") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

const applyPatchToolSchema = Type.Object({
	input: Type.String({
		description: "The full apply_patch payload in apply_patch format.",
	}),
});

type ApplyPatchProgressFile = {
	path: string;
	moveTo?: string;
	operation: "add" | "delete" | "update";
	added: number;
	removed: number;
	done?: boolean;
	semantic?: boolean;
};

type ApplyPatchRenderDetails = {
	stage?: "validate" | "apply" | "done";
	diff?: string;
	highlightedDiffRows?: ParsedDiffLine[];
	filesChanged?: number;
	operations?: number;
	currentFile?: string;
	files?: ApplyPatchProgressFile[];
	fileDiffs?: ApplyPatchProgressFile[];
	previewChanges?: ApplyPatchPreviewChange[];
	semantic?: boolean;
};

type ToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
};

type ThemeLike = {
	fg(color: string, text: string): string;
	bg?(color: ToolPanelBg, text: string): string;
	getBgAnsi?(color: ToolPanelBg): string;
	getFgAnsi?(color: string): string;
	bold(text: string): string;
};

type ToolPanelBg = "toolSuccessBg" | "toolPendingBg" | "toolErrorBg";

type CollapsedPreviewMode = "hidden" | "digest";
type ApplyPatchEditKind = "raw" | "semantic";

type ApplyPatchConfig = {
	maxDiffLines: number;
	resumeMaxDiffLines: number;
	collapsedPreview: CollapsedPreviewMode;
	digestMaxItems: number;
	syntaxHighlight: boolean;
	richRender: boolean;
	renderDiff: boolean;
	enforce: boolean;
	validateBeforeApply: boolean;
	recordUsageEntry: boolean;
	registerTool: boolean;
	activeByDefault: boolean;
	allowEditTool: boolean;
};

export const APPLY_PATCH_TOOL_DESCRIPTION =
	"Edit files using apply_patch. Use '*** Update Scope' when it is the shortest clear way to target an existing symbol; use '*** Update File' when plain text context is clearer. In one Update File section, author ordinary context hunks top-to-bottom because matching is cursor-forward; use '@@ lines A-B' only for explicit original-file ranges.";
export const APPLY_PATCH_FREEFORM_TOOL_DESCRIPTION =
	"Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON. In one Update File section, ordinary context hunks must be top-to-bottom; use `@@ lines A-B` for explicit original-file ranges.";

const DEFAULT_CONFIG: ApplyPatchConfig = {
	maxDiffLines: 160,
	resumeMaxDiffLines: 0,
	collapsedPreview: "hidden",
	digestMaxItems: 4,
	syntaxHighlight: true,
	richRender: true,
	renderDiff: true,
	enforce: true,
	validateBeforeApply: true,
	recordUsageEntry: true,
	registerTool: true,
	activeByDefault: true,
	allowEditTool: false,
};

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

function loadConfig(): ApplyPatchConfig {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<ApplyPatchConfig>;
		const collapsedPreview =
			parsed.collapsedPreview === "digest" || parsed.collapsedPreview === "hidden"
				? parsed.collapsedPreview
				: DEFAULT_CONFIG.collapsedPreview;
		return {
			maxDiffLines: Number.isFinite(parsed.maxDiffLines)
				? Math.max(1, Number(parsed.maxDiffLines))
				: DEFAULT_CONFIG.maxDiffLines,
			resumeMaxDiffLines: Number.isFinite(parsed.resumeMaxDiffLines)
				? Math.max(0, Number(parsed.resumeMaxDiffLines))
				: DEFAULT_CONFIG.resumeMaxDiffLines,
			collapsedPreview,
			digestMaxItems: Number.isFinite(parsed.digestMaxItems)
				? Math.max(1, Number(parsed.digestMaxItems))
				: DEFAULT_CONFIG.digestMaxItems,
			syntaxHighlight:
				typeof parsed.syntaxHighlight === "boolean" ? parsed.syntaxHighlight : DEFAULT_CONFIG.syntaxHighlight,
			richRender: typeof parsed.richRender === "boolean" ? parsed.richRender : DEFAULT_CONFIG.richRender,
			renderDiff: typeof parsed.renderDiff === "boolean" ? parsed.renderDiff : DEFAULT_CONFIG.renderDiff,
			enforce: typeof parsed.enforce === "boolean" ? parsed.enforce : DEFAULT_CONFIG.enforce,
			validateBeforeApply:
				typeof parsed.validateBeforeApply === "boolean"
					? parsed.validateBeforeApply
					: DEFAULT_CONFIG.validateBeforeApply,
			recordUsageEntry:
				typeof parsed.recordUsageEntry === "boolean" ? parsed.recordUsageEntry : DEFAULT_CONFIG.recordUsageEntry,
			registerTool: typeof parsed.registerTool === "boolean" ? parsed.registerTool : DEFAULT_CONFIG.registerTool,
			activeByDefault:
				typeof parsed.activeByDefault === "boolean" ? parsed.activeByDefault : DEFAULT_CONFIG.activeByDefault,
			allowEditTool: typeof parsed.allowEditTool === "boolean" ? parsed.allowEditTool : DEFAULT_CONFIG.allowEditTool,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

type DiffLineKind = "add" | "remove" | "context" | "hunk";

type ParsedDiffLine = {
	kind: DiffLineKind;
	oldLine: number | null;
	newLine: number | null;
	content: string;
	path?: string;
	scope?: ApplyPatchPreviewScope;
	highlightedContent?: string;
};

type ApplyPatchPreviewChange = {
	path?: string;
	type?: "add" | "update" | "delete" | "move";
	additions?: number;
	deletions?: number;
	move_path?: string | null;
	scopes?: ApplyPatchPreviewScope[];
};

type ApplyPatchPreviewScope = {
	name: string;
	kind: string;
	start_line: number;
	end_line: number;
};

type ApplyPatchPreviewResponse = {
	status?: "valid" | "invalid" | "empty";
	complete?: boolean;
	diff?: string;
	changes?: ApplyPatchPreviewChange[];
	error?: string;
};

type ApplyPatchRenderState = {
	elapsedTimer?: ReturnType<typeof setTimeout>;
	startedAtMs?: number;
	renderedLiveResult?: boolean;
	resultRendered?: boolean;
};

type ModelLike = {
	id?: string;
	provider?: string;
};

const ADD_ROW_BG = "\x1b[48;2;20;53;31m";
const REMOVE_ROW_BG = "\x1b[48;2;59;29;36m";
const SAFE_MUTED_FG = "\x1b[38;2;139;148;158m";
const SHIKI_THEME = (process.env.APPLY_PATCH_SHIKI_THEME ?? "github-dark") as BundledTheme;
const SHIKI_MAX_CHARS = 80_000;
const SHIKI_CACHE_LIMIT = 64;
const SHIKI_BACKGROUND_PATTERN = /\x1b\[(?:48;2;\d+;\d+;\d+|48;5;\d+|49)m/g;
const COMPLETED_PATCH_INPUT_LIMIT = 128;
const APPLY_PATCH_FRAME_MS = 120;
const APPLY_PATCH_LABEL = "Preparing patch…";

function editVerb(state: "success" | "pending" | "error", kind: ApplyPatchEditKind): string {
	void kind;
	return state === "pending" ? "Editing" : "Edited";
}

function editKindFromFiles(files: ApplyPatchProgressFile[] | undefined): ApplyPatchEditKind {
	return files?.some((file) => file.semantic) ? "semantic" : "raw";
}

function isSemanticPatchInput(input: string): boolean {
	return input.includes("*** Update Scope: ");
}
const shikiCache = new Map<string, string[]>();

function applyPatchElapsedMs(
	context: { state?: ApplyPatchRenderState } | undefined,
	running: boolean,
): number | undefined {
	const state = context?.state;
	if (!running || !state) return undefined;
	state.startedAtMs ??= Date.now();
	return Date.now() - state.startedAtMs;
}

function scheduleApplyPatchInvalidation(
	context: { state?: ApplyPatchRenderState; invalidate?: () => void } | undefined,
	running: boolean,
): void {
	const state = context?.state;
	if (!state) return;
	if (!running) {
		if (state.elapsedTimer) {
			clearTimeout(state.elapsedTimer);
			state.elapsedTimer = undefined;
		}
		return;
	}
	if (state.elapsedTimer || !context?.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		context.invalidate?.();
	}, APPLY_PATCH_FRAME_MS);
	state.elapsedTimer.unref?.();
}

function renderApplyPatchPreparingStatus(theme: ThemeLike, elapsedMs: number | undefined): string {
	const spinner = theme.fg("dim", runningFrame(elapsedMs, APPLY_PATCH_FRAME_MS));
	const label = shineText(theme, APPLY_PATCH_LABEL, elapsedMs, {
		role: "accent",
		fallback: (text) => theme.fg("warning", text),
	});
	return `${spinner} ${label}`;
}

class ApplyPatchDiffView {
	private renderedDiffCache?: {
		key: string;
		lines: string[];
	};
	private renderedOutputCache?: {
		width: number;
		lines: string[];
	};

	constructor(
		private label: string,
		private files: ApplyPatchProgressFile[],
		private fallbackBody: string,
		private theme: ThemeLike,
		private config: ApplyPatchConfig,
		private state: "success" | "pending" | "error" = "success",
		private status?: string,
		private diff?: string,
		private expanded = false,
		private rows?: ParsedDiffLine[],
		private maxDiffRows?: number,
		private editKind: ApplyPatchEditKind = "raw",
	) {}

	invalidate() {
		this.renderedDiffCache = undefined;
		this.renderedOutputCache = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		if (this.renderedOutputCache?.width === safeWidth) return this.renderedOutputCache.lines;
		const lines = this.renderUncached(safeWidth);
		this.renderedOutputCache = { width: safeWidth, lines };
		return lines;
	}

	private renderUncached(safeWidth: number): string[] {
		const safeRows = (lines: string[]) => lines.map((line) => clampRenderedLine(line, safeWidth));
		const bgToken =
			this.state === "error" ? "toolErrorBg" : this.state === "pending" ? "toolPendingBg" : "toolSuccessBg";
		const paintLine = (line: string) => paintPanelRow(line, safeWidth, this.theme, bgToken);

		if (this.rows && this.rows.length > 0) {
			const fileVerb = editVerb(this.state, this.editKind);
			const cacheKey = [
				"rows",
				safeWidth,
				this.expanded,
				this.maxDiffRows ?? "",
				fileVerb,
				this.editKind,
				this.rows.length,
			].join("\0");
			const diffLines =
				this.renderedDiffCache?.key === cacheKey
					? this.renderedDiffCache.lines
					: renderNativeDiffRows(
							this.rows,
							this.theme,
							safeWidth,
							undefined,
							this.config,
							this.expanded,
							this.maxDiffRows,
							fileVerb,
							this.editKind,
						);
			this.renderedDiffCache = { key: cacheKey, lines: diffLines };
			return safeRows(diffLines);
		}

		if (hasVisibleText(this.diff)) {
			if (!this.expanded && (this.maxDiffRows ?? this.config.maxDiffLines) <= 0) {
				const cacheKey = [
					"collapsed",
					safeWidth,
					this.config.collapsedPreview,
					this.config.digestMaxItems,
					this.diff.length,
				].join("\0");
				const diffLines =
					this.renderedDiffCache?.key === cacheKey
						? this.renderedDiffCache.lines
						: renderCollapsedDiffPreview(this.diff, this.files, this.theme, safeWidth, undefined, this.config);
				this.renderedDiffCache = { key: cacheKey, lines: diffLines };
				return safeRows(diffLines);
			}
			const fileVerb = editVerb(this.state, this.editKind);
			const cacheKey = [
				safeWidth,
				this.expanded,
				this.maxDiffRows ?? "",
				fileVerb,
				this.editKind,
				this.diff.length,
				this.rows?.length ?? "",
			].join("\0");
			const diffLines =
				this.renderedDiffCache?.key === cacheKey
					? this.renderedDiffCache.lines
					: renderNativeDiff(
							this.diff,
							this.rows,
							this.theme,
							safeWidth,
							undefined,
							this.config,
							this.expanded,
							this.maxDiffRows,
							fileVerb,
							this.editKind,
						);
			this.renderedDiffCache = { key: cacheKey, lines: diffLines };
			return safeRows(diffLines);
		}

		const bodyLines =
			this.state === "error" ? summarizePatchFailure(this.fallbackBody) : this.fallbackBody.split("\n");
		while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
		while (bodyLines.at(-1)?.trim() === "") bodyLines.pop();
		const content = bodyLines.length > 0 ? bodyLines : [this.theme.fg("muted", "(no diff)")];
		if (this.state === "error") {
			return safeRows([
				paintLine(this.renderHeader(safeWidth)),
				paintLine(""),
				...renderFailureDiagnosticRows(content, this.theme, safeWidth, bgToken),
			]);
		}

		const fallbackRole = this.state === "pending" ? "warning" : undefined;
		const contentLines = content.flatMap((line) => {
			const styledLine = fallbackRole ? this.theme.fg(fallbackRole, line) : line;
			return line.length === 0 ? [""] : wrapTextWithAnsi(styledLine, safeWidth);
		});
		return safeRows([
			paintLine(this.renderHeader(safeWidth)),
			paintLine(""),
			...contentLines.map((line) => paintLine(line)),
		]);
	}

	private renderHeader(width: number): string {
		const added = this.files.reduce((sum, file) => sum + file.added, 0);
		const removed = this.files.reduce((sum, file) => sum + file.removed, 0);
		const stats =
			this.files.length > 0
				? ` ${this.theme.fg("muted", "(")}${this.theme.fg("toolDiffAdded", `+${added}`)} ${this.theme.fg("toolDiffRemoved", `-${removed}`)}${this.theme.fg("muted", ")")}`
				: "";
		const verb =
			this.status ?? (this.state === "error" ? "Patch failed" : this.state === "pending" ? "Patching" : "Patched");
		const marker = this.state === "error" ? nf.error : this.state === "pending" ? nf.warn : nf.ok;
		const markerColor = this.state === "error" ? "error" : this.state === "pending" ? "warning" : "toolTitle";
		const title = `${this.theme.fg(markerColor, marker)} ${this.theme.fg("toolTitle", this.theme.bold(verb))} ${this.theme.fg("accent", this.label)}${stats}`;
		return truncateToWidth(title, width, "…", true);
	}
}

function diffDisplayLineCount(diff: string): number {
	return diff.replace(/\r\n?/g, "\n").split("\n").filter(Boolean).length;
}

type DiffDigestItem = {
	file?: string;
	newStart: number;
	added: number;
	removed: number;
	label: string;
	addedLabel: string;
	removedLabel: string;
};

function renderCollapsedDiffPreview(
	diff: string,
	files: ApplyPatchProgressFile[],
	theme: ThemeLike,
	width: number,
	background: string | undefined,
	config: ApplyPatchConfig,
): string[] {
	if (config.collapsedPreview === "digest") {
		const digest = buildDiffDigest(diff, config.digestMaxItems);
		if (digest.items.length > 0) {
			const showFile = files.length !== 1;
			const lines = digest.items.map((item) => renderDigestItem(item, showFile, theme, width, background));
			if (digest.remaining > 0) {
				lines.push(
					paintDiffRow(
						theme.fg("muted", `↳ ${digest.remaining} more hunk${digest.remaining === 1 ? "" : "s"} · `) +
							keyHint("app.tools.expand", "expand"),
						width,
						background,
					),
				);
			}
			return lines;
		}
	}

	const lineCount = diffDisplayLineCount(diff);
	return [
		paintDiffRow(
			theme.fg("muted", `↳ diff hidden · ${lineCount} line${lineCount === 1 ? "" : "s"} · `) +
				keyHint("app.tools.expand", "expand"),
			width,
			background,
		),
	];
}

function renderDigestItem(
	item: DiffDigestItem,
	showFile: boolean,
	theme: ThemeLike,
	width: number,
	background: string | undefined,
): string {
	const location = showFile && item.file ? `${compactPath(item.file)}:${item.newStart}` : `line ${item.newStart}`;
	const prefix = `${theme.fg("muted", "↳")} ${theme.fg("muted", location)} `;

	if (width < 86) {
		return paintDiffRow(
			`${prefix}${theme.fg("toolTitle", item.label)} ${theme.fg("toolDiffRemoved", `-${item.removed}`)} ${theme.fg("toolDiffAdded", `+${item.added}`)}`,
			width,
			background,
		);
	}

	const prefixWidth = visibleWidth(prefix);
	const separator = theme.fg("muted", " │ ");
	const available = Math.max(24, width - prefixWidth - visibleWidth(separator));
	const leftWidth = Math.max(12, Math.floor(available / 2));
	const rightWidth = Math.max(12, available - leftWidth);
	const left =
		item.removed > 0
			? `${theme.fg("toolDiffRemoved", "−")} ${theme.fg("toolTitle", item.removedLabel)} ${theme.fg("toolDiffRemoved", `${item.removed}`)}`
			: theme.fg("muted", "—");
	const right =
		item.added > 0
			? `${theme.fg("toolDiffAdded", "+")} ${theme.fg("toolTitle", item.addedLabel)} ${theme.fg("toolDiffAdded", `${item.added}`)}`
			: theme.fg("muted", "—");
	return paintDiffRow(
		`${prefix}${padToVisibleWidth(truncateToWidth(left, leftWidth, "…", true), leftWidth, { truncate: false })}${separator}${truncateToWidth(right, rightWidth, "…", true)}`,
		width,
		background,
	);
}

function buildDiffDigest(diff: string, maxItems: number): { items: DiffDigestItem[]; remaining: number } {
	const items: DiffDigestItem[] = [];
	let remaining = 0;
	let file: string | undefined;
	let current: { file?: string; newStart: number; added: string[]; removed: string[] } | undefined;

	const flush = () => {
		if (!current || (current.added.length === 0 && current.removed.length === 0)) {
			current = undefined;
			return;
		}
		const item: DiffDigestItem = {
			file: current.file,
			newStart: current.newStart,
			added: current.added.length,
			removed: current.removed.length,
			label: classifyDigestHunk(current.added, current.removed),
			addedLabel: classifyDigestLines(current.added),
			removedLabel: classifyDigestLines(current.removed),
		};
		if (items.length < maxItems) items.push(item);
		else remaining += 1;
		current = undefined;
	};

	for (const rawLine of diff.replace(/\r\n?/g, "\n").split("\n")) {
		if (rawLine.startsWith("+++ ")) {
			file = normalizeDiffHeaderPath(rawLine.slice(4));
			continue;
		}
		const hunk = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
		if (hunk) {
			flush();
			current = {
				file,
				newStart: Number.parseInt(hunk[1] ?? "0", 10),
				added: [],
				removed: [],
			};
			continue;
		}
		if (!current) continue;
		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) current.added.push(rawLine.slice(1));
		else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) current.removed.push(rawLine.slice(1));
	}
	flush();
	return { items, remaining };
}

function classifyDigestHunk(added: string[], removed: string[]): string {
	const addedLabel = classifyDigestLines(added);
	const removedLabel = classifyDigestLines(removed);
	if (added.length === 0) return `${removedLabel} removed`;
	if (removed.length === 0) return `${addedLabel} added`;
	if (addedLabel === removedLabel) return `${addedLabel} updated`;
	return `${removedLabel} → ${addedLabel}`;
}

function classifyDigestLines(lines: string[]): string {
	const changed = lines.map((line) => line.trim()).filter(Boolean);
	if (changed.length === 0) return "whitespace";
	if (changed.every(isCommentLikeLine)) return "comments/docs";
	if (changed.some((line) => /^import\b|^#include\b|^from\s+.+\s+import\b/.test(line))) return "imports";
	if (changed.some((line) => /\b(XCTAssert|assert|expect|require\.|t\.)\b/.test(line))) return "tests/assertions";
	if (changed.some((line) => /\b(class|struct|enum|protocol|interface|type|func|function)\b/.test(line)))
		return "declarations";
	if (changed.some((line) => /\b(if|guard|switch|for|while|return|throw|catch|await)\b/.test(line)))
		return "control flow";
	if (changed.some((line) => /\w+\s*\(|\)\s*(?:async\s*)?(?:throws\s*)?->/.test(line))) return "calls/logic";
	if (changed.some((line) => /[:=]/.test(line))) return "values/assignments";
	return "logic";
}

function isCommentLikeLine(line: string): boolean {
	return /^(?:\/\/|\/\*|\*|#|<!--|--)/.test(line.trim());
}

function isLowContrastShikiFg(rawParams: string): boolean {
	if (rawParams === "30" || rawParams === "90") return true;
	if (rawParams === "38;5;0" || rawParams === "38;5;8") return true;
	if (!rawParams.startsWith("38;2;")) return false;
	const parts = rawParams.split(";").map(Number);
	if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return false;
	const [, , red, green, blue] = parts;
	const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) =>
		isLowContrastShikiFg(rawParams) ? SAFE_MUTED_FG : sequence,
	);
}

function hasVisibleText(text: string | undefined): text is string {
	return !!text && text.replace(ANSI_PATTERN, "").trim().length > 0;
}

function normalizeLineForDiff(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
}

function highlightedLineMatches(candidate: string | undefined, expected: string): candidate is string {
	if (!candidate) return false;
	return candidate.replace(ANSI_PATTERN, "") === normalizeLineForDiff(expected);
}

function normalizeRepoPath(path: string): string {
	return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

function normalizeDiffHeaderPath(rawPath: string): string | undefined {
	const normalized = rawPath.trim().replace(/^a\//, "").replace(/^b\//, "");
	if (!normalized || normalized === "/dev/null") return undefined;
	return normalizeRepoPath(normalized);
}

function shikiLanguageForPath(path: string | undefined): BundledLanguage | undefined {
	return resolveShikiLanguageForPath(path);
}

function touchShikiCache(key: string, value: string[]): string[] {
	shikiCache.delete(key);
	shikiCache.set(key, value);
	while (shikiCache.size > SHIKI_CACHE_LIMIT) {
		const oldest = shikiCache.keys().next().value;
		if (oldest === undefined) break;
		shikiCache.delete(oldest);
	}
	return value;
}

async function highlightWithShiki(code: string, language: BundledLanguage): Promise<string[]> {
	if (!code) return [""];
	if (code.length > SHIKI_MAX_CHARS) return code.split("\n");

	const normalized = normalizeLineForDiff(code);
	const cacheKey = `${SHIKI_THEME}\0${language}\0${normalized}`;
	const cached = shikiCache.get(cacheKey);
	if (cached) return touchShikiCache(cacheKey, cached);

	try {
		const { codeToANSI } = await import("@shikijs/cli");
		const ansi = normalizeShikiContrast(
			(await codeToANSI(normalized, language, SHIKI_THEME)).replace(SHIKI_BACKGROUND_PATTERN, ""),
		);
		const lines = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return touchShikiCache(cacheKey, lines);
	} catch {
		return normalized.split("\n");
	}
}

type HighlightedFileSource = {
	path: string;
	language: BundledLanguage;
	content: string;
};

function readNormalizedTextFile(path: string): string | undefined {
	try {
		if (statSync(path).size > SHIKI_MAX_CHARS) return undefined;
		return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
	} catch {
		return undefined;
	}
}

function collectShikiSources(
	cwd: string,
	files: ApplyPatchProgressFile[],
	pathForFile: (file: ApplyPatchProgressFile) => string | undefined,
): HighlightedFileSource[] {
	const sources: HighlightedFileSource[] = [];
	for (const file of files) {
		const targetPath = pathForFile(file);
		if (!targetPath) continue;
		const language = shikiLanguageForPath(targetPath);
		if (!language) continue;
		const content = readNormalizedTextFile(resolve(cwd, targetPath));
		if (content === undefined) continue;
		sources.push({
			path: normalizeRepoPath(targetPath),
			language,
			content,
		});
	}
	return sources;
}

function collectPrePatchShikiSources(cwd: string, files: ApplyPatchProgressFile[]): HighlightedFileSource[] {
	return collectShikiSources(cwd, files, (file) => (file.operation === "add" ? undefined : file.path));
}

function collectPostPatchShikiSources(cwd: string, files: ApplyPatchProgressFile[]): HighlightedFileSource[] {
	return collectShikiSources(cwd, files, (file) =>
		file.operation === "delete" ? undefined : (file.moveTo ?? file.path),
	);
}

async function highlightSources(
	sources: HighlightedFileSource[],
	signal?: AbortSignal,
): Promise<Map<string, string[]>> {
	const entries = await Promise.all(
		sources.map(async (source) => {
			if (signal?.aborted) return undefined;
			return [source.path, await highlightWithShiki(source.content, source.language)] as const;
		}),
	);
	return new Map(entries.filter((entry): entry is readonly [string, string[]] => entry !== undefined));
}

function highlightedContentForRow(
	row: ParsedDiffLine,
	oldHighlights: Map<string, string[]>,
	newHighlights: Map<string, string[]>,
): string | undefined {
	const path = row.path ? normalizeRepoPath(row.path) : undefined;
	if (!path) return undefined;
	let candidate: string | undefined;

	if (row.kind === "remove" && row.oldLine !== null) {
		candidate = oldHighlights.get(path)?.[row.oldLine - 1];
		return highlightedLineMatches(candidate, row.content) ? candidate : undefined;
	}

	if (row.newLine !== null) {
		const oldIndex = row.oldLine !== null ? row.oldLine - 1 : row.newLine - 1;
		candidate = newHighlights.get(path)?.[row.newLine - 1] ?? oldHighlights.get(path)?.[oldIndex];
		return highlightedLineMatches(candidate, row.content) ? candidate : undefined;
	}

	return undefined;
}

async function buildHighlightedDiffRows(
	diff: string,
	oldSources: HighlightedFileSource[],
	newSources: HighlightedFileSource[],
	signal?: AbortSignal,
): Promise<ParsedDiffLine[]> {
	const rows = parseUnifiedDiff(diff);
	if (rows.length === 0 || signal?.aborted) return rows;

	const [oldHighlights, newHighlights] = await Promise.all([
		highlightSources(oldSources, signal),
		highlightSources(newSources, signal),
	]);

	if (oldHighlights.size === 0 && newHighlights.size === 0) return rows;

	return rows.map((row) => ({
		...row,
		highlightedContent: highlightedContentForRow(row, oldHighlights, newHighlights),
	}));
}

function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
	const rows: ParsedDiffLine[] = [];
	let currentPath: string | undefined;
	let oldPath: string | undefined;
	let newPath: string | undefined;
	let oldLine: number | null = null;
	let newLine: number | null = null;

	for (const rawLine of diff.replace(/\r\n?/g, "\n").split("\n")) {
		if (rawLine.startsWith("--- ")) {
			oldPath = normalizeDiffHeaderPath(rawLine.slice(4));
			currentPath = oldPath ?? newPath;
			continue;
		}

		if (rawLine.startsWith("+++ ")) {
			newPath = normalizeDiffHeaderPath(rawLine.slice(4));
			currentPath = newPath ?? oldPath;
			continue;
		}

		const hunk = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
		if (hunk) {
			oldLine = Number.parseInt(hunk[1] ?? "0", 10);
			newLine = Number.parseInt(hunk[2] ?? "0", 10);
			rows.push({
				kind: "hunk",
				oldLine: null,
				newLine: null,
				content: rawLine,
				path: newPath ?? oldPath ?? currentPath,
			});
			continue;
		}

		if (oldLine === null || newLine === null) continue;
		if (rawLine.startsWith("\\")) continue;

		if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			rows.push({
				kind: "remove",
				oldLine,
				newLine: null,
				content: rawLine.slice(1),
				path: oldPath ?? currentPath,
			});
			oldLine += 1;
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			rows.push({
				kind: "add",
				oldLine: null,
				newLine,
				content: rawLine.slice(1),
				path: newPath ?? currentPath,
			});
			newLine += 1;
			continue;
		}

		if (rawLine.startsWith(" ")) {
			rows.push({
				kind: "context",
				oldLine,
				newLine,
				content: rawLine.slice(1),
				path: newPath ?? oldPath ?? currentPath,
			});
			oldLine += 1;
			newLine += 1;
		}
	}

	return rows;
}

function previewScopesByPath(changes: ApplyPatchPreviewChange[] | undefined): Map<string, ApplyPatchPreviewScope[]> {
	const byPath = new Map<string, ApplyPatchPreviewScope[]>();
	for (const change of changes ?? []) {
		if (!change.path || !Array.isArray(change.scopes)) continue;
		byPath.set(change.path, change.scopes);
	}
	return byPath;
}

function parseUnifiedDiffWithScopes(diff: string, changes: ApplyPatchPreviewChange[] | undefined): ParsedDiffLine[] {
	const rows = parseUnifiedDiff(diff);
	const scopesByPath = previewScopesByPath(changes);
	for (const row of rows) {
		const line = row.newLine ?? row.oldLine;
		if (!row.path || line === null) continue;
		const scopes = scopesByPath.get(row.path);
		if (!scopes?.length) continue;
		row.scope = scopes
			.filter((scope) => scope.start_line <= line && line <= scope.end_line)
			.sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line) || b.start_line - a.start_line)[0];
	}
	return rows;
}

function mergeScopedDiffRows(
	rows: ParsedDiffLine[] | undefined,
	scopedRows: ParsedDiffLine[] | undefined,
): ParsedDiffLine[] | undefined {
	if (!rows) return scopedRows;
	if (!scopedRows) return rows;
	return rows.map((row, index) => ({
		...row,
		scope: row.scope ?? scopedRows[index]?.scope,
	}));
}

function languageForPath(path: string | undefined): string | undefined {
	return resolveInlineLanguageForPath(path);
}

function highlightDiffContent(content: string, path: string | undefined): string {
	const normalized = content.replace(/\t/g, "  ");
	const language = languageForPath(path);
	if (!language || normalized.length === 0) return normalized;
	if (language === "wgsl") return highlightWgslAnsi(normalized)[0] ?? normalized;
	try {
		return highlightCode(normalized, language)[0] ?? normalized;
	} catch {
		return normalized;
	}
}

function formatDiffLineNumber(value: number | null, width: number): string {
	return value === null ? " ".repeat(width) : String(value).padStart(width, " ");
}

function rowBackground(kind: DiffLineKind): string | undefined {
	if (kind === "add") return ADD_ROW_BG;
	if (kind === "remove") return REMOVE_ROW_BG;
	return undefined;
}
function paintDiffRow(line: string, width: number, background: string | undefined): string {
	return paintAnsiBackgroundRow(line, width, background);
}
function clampRenderedLine(line: string, width: number): string {
	return clampAnsiLine(line, width);
}
function paintPanelRow(line: string, width: number, theme: ThemeLike, background: ToolPanelBg): string {
	const backgroundAnsi = theme.getBgAnsi?.(background);
	if (backgroundAnsi) return paintAnsiBackgroundRow(line, width, backgroundAnsi);
	const padded = truncateToWidth(line, width, "", true);
	return theme.bg ? theme.bg(background, padded) : padded;
}

function styleFailureDiagnosticLine(line: string, index: number, theme: ThemeLike): string {
	const normalized = line.replace(/\t/g, "  ");
	if (index === 0 && normalized.startsWith("Error:")) return theme.fg("error", normalized);
	if (
		normalized.startsWith("file state ") ||
		normalized.startsWith("available files:") ||
		normalized.startsWith("suggested anchors:") ||
		normalized.startsWith("this file's mtime ")
	) {
		return theme.fg("muted", normalized);
	}
	const sourceLine = normalized.match(/^(\d+:)(.*)$/);
	if (sourceLine) return `${theme.fg("dim", sourceLine[1] ?? "")}${sourceLine[2] ?? ""}`;
	return normalized;
}

function summarizePatchFailure(text: string): string[] {
	const lines = text
		.replace(ANSI_PATTERN, "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	if (lines.length <= 12) return lines;

	const selected: string[] = [];
	const add = (line: string | undefined) => {
		if (line && !selected.includes(line) && selected.length < 12) selected.push(line);
	};

	add(lines[0]);
	for (const line of lines.slice(1)) {
		if (
			line.startsWith("file state ") ||
			line.startsWith("available files:") ||
			line.startsWith("suggested anchors:")
		) {
			add(line);
		}
	}
	for (const line of lines.slice(1)) {
		if (line.includes("@@ lines ") || line.includes("candidate")) add(line);
	}
	for (const line of lines.slice(1)) {
		if (/^\s*\d+:/.test(line)) add(line);
	}
	if (selected.length < lines.length || lines.some((line) => !selected.includes(line))) {
		const omitted = lines.filter((line) => !selected.includes(line)).length;
		const summary = `… ${omitted} more diagnostic line${omitted === 1 ? "" : "s"} omitted`;
		if (selected.length >= 12) selected[selected.length - 1] = summary;
		else add(summary);
	}
	return selected;
}

function renderFailureDiagnosticRows(
	lines: string[],
	theme: ThemeLike,
	width: number,
	background: ToolPanelBg,
): string[] {
	return lines.flatMap((line, index) => {
		if (line.length === 0) return [];
		const styledLine = styleFailureDiagnosticLine(line, index, theme);
		return wrapTextWithAnsi(styledLine, width).map((row) => paintPanelRow(row, width, theme, background));
	});
}

function diffLineNumberWidth(rows: ParsedDiffLine[]): number {
	const maxLineNumber = rows.reduce((max, row) => Math.max(max, row.oldLine ?? 0, row.newLine ?? 0), 0);
	return Math.max(2, String(maxLineNumber).length);
}

function diffWrapRows(width: number): number {
	if (width >= 180) return 3;
	if (width >= 120) return 2;
	return 1;
}

function wrapDiffContent(content: string, width: number, maxRows: number): string[] {
	if (width <= 0) return [""];
	const wrapped = content.length === 0 ? [""] : wrapTextWithAnsi(content, width);
	if (wrapped.length <= maxRows) {
		return wrapped.map((line) => truncateToWidth(line, width, "", true));
	}
	return wrapped
		.slice(0, maxRows)
		.map((line, index) => truncateToWidth(line, width, index === maxRows - 1 ? "…" : "", true));
}

function diffContentForRow(row: ParsedDiffLine): string {
	return row.highlightedContent ?? highlightDiffContent(row.content, row.path);
}

function diffFileStats(rows: ParsedDiffLine[], path: string | undefined): { added: number; removed: number } {
	const key = path ?? "patch";
	const stats = { added: 0, removed: 0 };
	for (const row of rows) {
		if ((row.path ?? "patch") !== key) continue;
		if (row.kind === "add") stats.added += 1;
		if (row.kind === "remove") stats.removed += 1;
	}
	return stats;
}

function diffScopeStats(
	rows: ParsedDiffLine[],
	path: string | undefined,
	scope: ApplyPatchPreviewScope,
): { added: number; removed: number } {
	const key = path ?? "patch";
	const scopeKey = formatScopeKey(path, scope);
	const stats = { added: 0, removed: 0 };
	for (const row of rows) {
		if ((row.path ?? "patch") !== key) continue;
		if (formatScopeKey(row.path, row.scope) !== scopeKey) continue;
		if (row.kind === "add") stats.added += 1;
		if (row.kind === "remove") stats.removed += 1;
	}
	return stats;
}

function formatScopeKey(path: string | undefined, scope: ApplyPatchPreviewScope | undefined): string | undefined {
	return scope ? `${path ?? ""}:${scope.kind}:${scope.name}:${scope.start_line}-${scope.end_line}` : undefined;
}

function renderScopeHeader(
	theme: ThemeLike,
	scope: ApplyPatchPreviewScope,
	stats: { added: number; removed: number },
	numberWidth: number,
	width: number,
	baseBackground: string | undefined,
): string {
	const label = `${" ".repeat(numberWidth)} ${theme.fg("dim", "▾")} ${theme.fg(
		"muted",
		`${scope.kind} `,
	)}${theme.fg("accent", scope.name)}${theme.fg("dim", `:${scope.start_line}-${scope.end_line}`)} ${theme.fg("muted", "(")}${theme.fg("toolDiffAdded", `+${stats.added}`)}${theme.fg("muted", ", ")}${theme.fg("toolDiffRemoved", `-${stats.removed}`)}${theme.fg("muted", ")")}`;
	return paintDiffRow(label, width, baseBackground);
}

function editBlockHeader(
	theme: ThemeLike,
	fileVerb: string,
	path: string | undefined,
	scope: ApplyPatchPreviewScope | undefined,
	stats: { added: number; removed: number },
	editKind: ApplyPatchEditKind,
): string {
	const target =
		editKind === "semantic" && scope
			? `${theme.fg("accent", path ?? "patch")} ${theme.fg("muted", "›")} ${theme.fg("muted", `${scope.kind} `)}${theme.fg("accent", scope.name)}${theme.fg("dim", `:${scope.start_line}-${scope.end_line}`)}`
			: theme.fg("accent", path ?? "patch");
	return `${theme.fg("muted", "•")} ${theme.bold(fileVerb)} ${target} ${theme.fg("muted", "(")}${theme.fg("toolDiffAdded", `+${stats.added}`)} ${theme.fg("toolDiffRemoved", `-${stats.removed}`)}${theme.fg("muted", ")")}`;
}

function renderUnifiedDiffRows(
	rows: ParsedDiffLine[],
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
	fileVerb = "Edited",
	editKind: ApplyPatchEditKind = "raw",
): string[] {
	void editKind;
	const numberWidth = diffLineNumberWidth(rows);
	const gutterWidth = numberWidth + 3;
	const codeWidth = Math.max(8, width - gutterWidth);
	const wrapLimit = diffWrapRows(width);
	const lines: string[] = [];
	let currentPath: string | undefined;
	let currentScopeKey: string | undefined;

	for (const row of rows) {
		const rowPath = row.path ?? currentPath ?? "patch";
		if (rowPath !== currentPath) {
			if (lines.length > 0) lines.push(paintDiffRow("", width, baseBackground));
			currentPath = rowPath;
			currentScopeKey = undefined;
			lines.push(
				paintDiffRow(
					editBlockHeader(theme, fileVerb, rowPath, undefined, diffFileStats(rows, rowPath), "raw"),
					width,
					baseBackground,
				),
			);
		}

		const scopeKey =
			(row.kind === "add" || row.kind === "remove") && row.scope
				? `${row.path ?? ""}:${row.scope.kind}:${row.scope.name}:${row.scope.start_line}-${row.scope.end_line}`
				: undefined;
		if (scopeKey && scopeKey !== currentScopeKey) {
			currentScopeKey = scopeKey;
			const stats = diffScopeStats(rows, row.path, row.scope!);
			if (stats.added > 0 || stats.removed > 0) {
				lines.push(renderScopeHeader(theme, row.scope!, stats, numberWidth, width, baseBackground));
			}
		}

		if (row.kind === "hunk") {
			currentScopeKey = undefined;
			continue;
		}

		const kindColor = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "dim";
		const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
		const lineNumber = row.kind === "remove" ? row.oldLine : row.newLine;
		const background = rowBackground(row.kind) ?? baseBackground;
		const prefix = `  ${theme.fg(kindColor, formatDiffLineNumber(lineNumber, numberWidth))} ${theme.fg(kindColor, sign)} `;
		const continuation = `  ${" ".repeat(numberWidth)}   `;
		const bodyLines = wrapDiffContent(diffContentForRow(row), codeWidth, wrapLimit);
		for (const [index, body] of bodyLines.entries()) {
			lines.push(paintDiffRow(`${index === 0 ? prefix : continuation}${body}`, width, background));
		}
	}

	return lines;
}

function limitDiffRows(
	rows: string[],
	config: ApplyPatchConfig,
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
	expanded: boolean,
	maxRows = config.maxDiffLines,
): string[] {
	if (expanded) return rows;
	if (maxRows <= 0) {
		return [
			paintDiffRow(
				theme.fg("muted", `Diff hidden (${rows.length} line${rows.length === 1 ? "" : "s"}; `) +
					keyHint("app.tools.expand", "to expand") +
					theme.fg("muted", ")"),
				width,
				baseBackground,
			),
		];
	}
	if (rows.length <= maxRows) return rows;
	const isStructuralHeader = (line: string): boolean => {
		const plain = line.replace(ANSI_PATTERN, "").trimStart();
		return plain.startsWith("• ") || plain.startsWith("▾ ");
	};
	const structuralHeaderKey = (line: string): string => line.replace(ANSI_PATTERN, "").trim();
	const renderCollapsedFooter = (count: number): string =>
		paintDiffRow(
			theme.fg("muted", `… ${count} collapsed diff line${count === 1 ? "" : "s"} (`) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
			width,
			baseBackground,
		);
	const structuralIndexes = rows
		.map((line, index) => (isStructuralHeader(line) ? index : -1))
		.filter((index) => index >= 0);
	if (structuralIndexes.length > 0) {
		const included = new Set(structuralIndexes);
		const renderedHeaders = new Set<string>();
		const limited: string[] = [];
		for (const [index, row] of rows.entries()) {
			if (!included.has(index)) continue;
			const key = structuralHeaderKey(row);
			if (renderedHeaders.has(key)) continue;
			renderedHeaders.add(key);
			limited.push(row);
		}
		const collapsed = rows.length - limited.length;
		if (collapsed > 0) limited.push(renderCollapsedFooter(collapsed));
		return limited;
	}
	const shownBudget = Math.max(1, maxRows - 1);
	const headCount =
		shownBudget <= 4
			? Math.max(1, Math.floor(shownBudget / 2))
			: Math.max(2, Math.min(8, Math.ceil(shownBudget / 3)));
	const tailCount = Math.max(0, shownBudget - headCount);
	const head = rows.slice(0, headCount);
	const tail = tailCount > 0 ? rows.slice(rows.length - tailCount) : [];
	const remaining = Math.max(0, rows.length - head.length - tail.length);
	return [
		...head,
		paintDiffRow(
			theme.fg("muted", `… ${remaining} more diff line${remaining === 1 ? "" : "s"} (`) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
			width,
			baseBackground,
		),
		...tail,
	];
}

function renderNativeDiff(
	diff: string,
	rows: ParsedDiffLine[] | undefined,
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
	config: ApplyPatchConfig,
	expanded: boolean,
	maxRows = config.maxDiffLines,
	fileVerb = "Edited",
	editKind: ApplyPatchEditKind = "raw",
): string[] {
	if (!expanded && maxRows <= 0) {
		const lineCount = diff.replace(/\r\n?/g, "\n").split("\n").filter(Boolean).length;
		return [
			paintDiffRow(
				theme.fg("muted", `Diff hidden (${lineCount} line${lineCount === 1 ? "" : "s"}; `) +
					keyHint("app.tools.expand", "to expand") +
					theme.fg("muted", ")"),
				width,
				baseBackground,
			),
		];
	}
	const diffRows = rows ?? parseUnifiedDiff(diff);
	if (diffRows.length === 0) return [];
	return renderNativeDiffRows(diffRows, theme, width, baseBackground, config, expanded, maxRows, fileVerb, editKind);
}

function renderNativeDiffRows(
	diffRows: ParsedDiffLine[],
	theme: ThemeLike,
	width: number,
	baseBackground: string | undefined,
	config: ApplyPatchConfig,
	expanded: boolean,
	maxRows = config.maxDiffLines,
	fileVerb = "Edited",
	editKind: ApplyPatchEditKind = "raw",
): string[] {
	const rendered = renderUnifiedDiffRows(diffRows, theme, width, baseBackground, fileVerb, editKind);
	return limitDiffRows(rendered, config, theme, width, baseBackground, expanded, maxRows);
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function patchInputKey(input: string): string {
	const normalized = input.replace(/\r\n?/g, "\n").trimEnd();
	return normalized ? createHash("sha256").update(normalized).digest("base64url") : "";
}

function rememberCompletedPatchInput(keys: Set<string>, key: string): void {
	if (!key) return;
	keys.delete(key);
	keys.add(key);
	while (keys.size > COMPLETED_PATCH_INPUT_LIMIT) {
		const oldest = keys.values().next().value;
		if (oldest === undefined) break;
		keys.delete(oldest);
	}
}

function formatTarget(file: Pick<ApplyPatchProgressFile, "path" | "moveTo">): string {
	return file.moveTo ? `${file.path} -> ${file.moveTo}` : file.path;
}

function compactPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function compactTarget(file: Pick<ApplyPatchProgressFile, "path" | "moveTo">): string {
	return file.moveTo ? `${compactPath(file.path)} -> ${compactPath(file.moveTo)}` : compactPath(file.path);
}

function operationCode(operation: ApplyPatchProgressFile["operation"], moveTo?: string): string {
	if (moveTo) return "R";
	if (operation === "add") return "A";
	if (operation === "delete") return "D";
	return "U";
}

function formatCounterLine(
	theme: {
		fg(color: string, text: string): string;
		bold(text: string): string;
	},
	file: ApplyPatchProgressFile,
	options?: { currentFile?: string; showDone?: boolean; includePath?: boolean },
): string {
	const includePath = options?.includePath ?? true;
	let line = `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `-${file.removed}`)} ${theme.fg("warning", operationCode(file.operation, file.moveTo))}`;
	if (includePath) {
		line += ` ${theme.fg("accent", formatTarget(file))}`;
	}
	if (options?.showDone && file.done) {
		line += theme.fg("muted", " ✓");
	} else if (options?.currentFile && options.currentFile === file.path) {
		line += theme.fg("warning", " ← applying");
	}
	return line;
}

function renderPatchSummary(
	theme: ThemeLike,
	files: ApplyPatchProgressFile[],
	count: number,
	options?: { currentFile?: string; showDone?: boolean },
): string {
	const title = theme.fg("toolTitle", theme.bold("apply_patch"));
	if (files.length === 1) {
		return `${title} ${formatCounterLine(theme, files[0], options)}`;
	}

	let text = title;
	text += theme.fg("muted", ` (${count} file${count === 1 ? "" : "s"})`);
	if (files.length > 0) {
		text += `\n${files.map((file) => formatCounterLine(theme, file, options)).join("\n")}`;
	}
	return text;
}

function renderApplyPatchBox(
	theme: ThemeLike,
	diff: string | undefined,
	files: ApplyPatchProgressFile[],
	count: number,
	config: ApplyPatchConfig,
	state: "success" | "pending" | "error" = "success",
	status?: string,
	expanded = false,
	rows?: ParsedDiffLine[],
	maxDiffRows?: number,
): ApplyPatchDiffView {
	const target = files.length === 1 ? compactTarget(files[0]) : `${count} files`;
	const summary = renderPatchSummary(theme, files, count, { showDone: true });
	return new ApplyPatchDiffView(
		target,
		files,
		summary,
		theme,
		config,
		state,
		status,
		diff,
		expanded,
		rows,
		maxDiffRows,
		editKindFromFiles(files),
	);
}

function parsePatchInputProgress(input: string): {
	totalOperations: number;
	files: ApplyPatchProgressFile[];
} {
	const files: ApplyPatchProgressFile[] = [];
	const lines = input.replace(/\r\n?/g, "\n").split("\n");
	let current: ApplyPatchProgressFile | undefined;
	let inPatch = false;

	const flush = () => {
		if (!current) return;
		files.push(current);
		current = undefined;
	};

	for (const line of lines) {
		if (line === "*** Begin Patch") {
			inPatch = true;
			continue;
		}
		if (line === "*** End Patch") {
			flush();
			break;
		}
		if (!inPatch) continue;

		if (line.startsWith("*** Add File: ")) {
			flush();
			current = {
				path: line.slice("*** Add File: ".length).trim(),
				operation: "add",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			flush();
			current = {
				path: line.slice("*** Delete File: ".length).trim(),
				operation: "delete",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Move File: ")) {
			flush();
			const spec = line.slice("*** Move File: ".length).trim();
			const [from, to] = spec.split(" -> ", 2);
			current = {
				path: from?.trim() ?? spec,
				moveTo: to?.trim(),
				operation: "update",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Replace All In File: ")) {
			flush();
			current = {
				path: line.slice("*** Replace All In File: ".length).trim(),
				operation: "update",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			flush();
			current = {
				path: line.slice("*** Update File: ".length).trim(),
				operation: "update",
				added: 0,
				removed: 0,
			};
			continue;
		}
		if (line.startsWith("*** Update Scope: ")) {
			flush();
			current = {
				path: line.slice("*** Update Scope: ".length).trim(),
				operation: "update",
				added: 0,
				removed: 0,
				semantic: true,
			};
			continue;
		}
		if (line.startsWith("*** Move to: ")) {
			if (current) current.moveTo = line.slice("*** Move to: ".length).trim();
			continue;
		}

		if (!current) continue;
		if (current.operation === "delete") continue;
		if (current.operation === "add") {
			if (line.startsWith("+")) current.added += 1;
			continue;
		}

		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) current.added += 1;
		if (line.startsWith("-")) current.removed += 1;
	}

	flush();
	return { totalOperations: files.length, files };
}

function markFilesSemantic(files: ApplyPatchProgressFile[], semantic: boolean): ApplyPatchProgressFile[] {
	return semantic ? files.map((file) => ({ ...file, semantic: file.semantic ?? true })) : files;
}

function parsePreviewResponse(stdout: string): ApplyPatchPreviewResponse | undefined {
	const line = stdout
		.trim()
		.split("\n")
		.find((candidate) => candidate.trim().startsWith("{"));
	if (!line) return undefined;
	try {
		return JSON.parse(line) as ApplyPatchPreviewResponse;
	} catch {
		return undefined;
	}
}

async function runApplyPatchPreview(
	cwd: string,
	input: string,
	signal?: AbortSignal,
	partial = false,
): Promise<ApplyPatchPreviewResponse | undefined> {
	const args = ["apply-patch", "preview", "--cwd", cwd];
	if (partial) args.push("--partial");
	const { stdout } = await runExternalCommand("ct", args, cwd, {
		signal,
		input,
	});
	return parsePreviewResponse(stdout);
}

function parseApplyPatchSummary(stdout: string): number {
	return stdout
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^(?:A|M|D|R)\s+/.test(line)).length;
}

function trimOutput(text: string): string {
	return text.trim();
}

function errorResult(message: string, details: Record<string, unknown> = {}): ToolResult {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { error: true, message, ...details },
	};
}

function makeResult(
	command: string,
	cwd: string,
	stdout: string,
	stderr: string,
	details: Record<string, unknown>,
): ToolResult {
	const text = trimOutput(stdout) || trimOutput(stderr) || "(no output)";
	return {
		content: [{ type: "text", text }],
		details: { command, cwd, stdout, stderr, ...details },
	};
}

function runApplyPatch(cwd: string, input: string, dryRun: boolean, signal?: AbortSignal) {
	const args = ["apply-patch", "--cwd", cwd];
	if (dryRun) args.push("--dry-run");
	return runExternalCommand("ct", args, cwd, { signal, input });
}

function enforceToolPolicy(pi: ExtensionAPI, config: ApplyPatchConfig): void {
	if (!config.enforce) return;

	const active = pi.getActiveTools();
	const next = active.filter((toolName) => toolName !== "write" && (config.allowEditTool || toolName !== "edit"));

	if (!next.includes(APPLY_PATCH_TOOL_NAME)) {
		next.push(APPLY_PATCH_TOOL_NAME);
	}

	if (!arraysEqual(active, next)) {
		pi.setActiveTools(next);
	}
}

function applyToolAvailability(pi: ExtensionAPI, config: ApplyPatchConfig): void {
	if (!config.registerTool || config.activeByDefault) return;
	const active = pi.getActiveTools();
	const next = active.filter((toolName) => toolName !== APPLY_PATCH_TOOL_NAME);
	if (!arraysEqual(active, next)) pi.setActiveTools(next);
}

function isCodexModel(model: ModelLike | undefined): boolean {
	const provider = model?.provider?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	return provider.includes("codex") || id.includes("codex");
}

export default function applyPatchExtension(pi: ExtensionAPI) {
	registerApplyPatchFreeformProvider(pi, {
		toolName: APPLY_PATCH_TOOL_NAME,
		description: APPLY_PATCH_FREEFORM_TOOL_DESCRIPTION,
		grammar: APPLY_PATCH_GRAMMAR,
		toolConfigs: {
			edit: () => {
				const mode = getConfiguredEditMode();
				if (mode === "apply_patch") {
					return { description: APPLY_PATCH_FREEFORM_TOOL_DESCRIPTION, grammar: APPLY_PATCH_GRAMMAR };
				}
				return getEditFreeformToolConfig();
			},
		},
	});

	const config = loadConfig();
	const executingPatchInputs = new Set<string>();
	const completedPatchInputs = new Set<string>();
	const toolsRemovedForCodex = new Set<string>();

	const applyCodexToolPolicy = (ctx?: ExtensionContext) => {
		if (!ctx) return;
		const active = pi.getActiveTools();
		const codexModel = isCodexModel(ctx.model);
		let next = active.filter((toolName) => {
			if (codexModel && (toolName === "write" || (!config.allowEditTool && toolName === "edit"))) {
				toolsRemovedForCodex.add(toolName);
				return false;
			}
			return true;
		});

		if (codexModel && config.registerTool && !next.includes(APPLY_PATCH_TOOL_NAME)) {
			next = [...next, APPLY_PATCH_TOOL_NAME];
		}

		if (!codexModel && toolsRemovedForCodex.size > 0) {
			const registeredTools = new Set(
				((pi as any).getAllTools?.() ?? []).map((tool: { name?: string }) => tool.name),
			);
			for (const toolName of toolsRemovedForCodex) {
				if ((!registeredTools.size || registeredTools.has(toolName)) && !next.includes(toolName)) {
					next.push(toolName);
				}
			}
			toolsRemovedForCodex.clear();
		}

		if (!arraysEqual(active, next)) {
			pi.setActiveTools(next);
		}
	};

	const resetSessionState = (_event?: unknown, ctx?: ExtensionContext) => {
		executingPatchInputs.clear();
		completedPatchInputs.clear();
		applyToolAvailability(pi, config);
		enforceToolPolicy(pi, config);
		applyCodexToolPolicy(ctx);
	};

	pi.on("session_start", resetSessionState);
	pi.on("session_tree", resetSessionState);
	pi.on("model_select", (_event, ctx) => {
		applyToolAvailability(pi, config);
		enforceToolPolicy(pi, config);
		applyCodexToolPolicy(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		applyToolAvailability(pi, config);
		enforceToolPolicy(pi, config);
		applyCodexToolPolicy(ctx);
	});

	pi.on("tool_call", (event, ctx) => {
		if (
			(event.toolName === "write" || (!config.allowEditTool && event.toolName === "edit")) &&
			isCodexModel(ctx?.model)
		) {
			return {
				block: true,
				reason: config.allowEditTool
					? "write is disabled for Codex models. Use edit or apply_patch instead."
					: "edit and write are disabled for Codex models. Use apply_patch instead.",
			};
		}
		if (!config.enforce) return;
		if (event.toolName === "write" || (!config.allowEditTool && event.toolName === "edit")) {
			return {
				block: true,
				reason: config.allowEditTool
					? "write is disabled. Use edit or apply_patch instead."
					: "edit and write are disabled. Use apply_patch instead.",
			};
		}
	});

	if (!config.registerTool) return;

	pi.registerTool({
		name: APPLY_PATCH_TOOL_NAME,
		label: APPLY_PATCH_TOOL_NAME,
		description: APPLY_PATCH_TOOL_DESCRIPTION,
		promptGuidelines: [
			"Use `apply_patch` for manual code edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`.",
		],
		parameters: applyPatchToolSchema,
		renderShell: "self",
		executionMode: "sequential",
		renderCall(_args, theme, context) {
			if (!config.richRender) return textComponent(title(theme, nf.apply, "apply_patch"));
			const state = context.state as ApplyPatchRenderState;
			if (!context.isPartial || state.resultRendered || context.executionStarted) {
				scheduleApplyPatchInvalidation(
					context as { state?: ApplyPatchRenderState; invalidate?: () => void },
					false,
				);
				return new EmptyComponent();
			}
			scheduleApplyPatchInvalidation(context as { state?: ApplyPatchRenderState; invalidate?: () => void }, true);
			return textComponent(
				renderApplyPatchPreparingStatus(
					theme,
					applyPatchElapsedMs(context as { state?: ApplyPatchRenderState }, true),
				),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (!config.richRender) {
				const details = result.details as ApplyPatchRenderDetails | undefined;
				const textBlock = result.content.find((block) => block.type === "text");
				const baseText = textBlock?.type === "text" ? textBlock.text : "";
				const count = details?.filesChanged ?? details?.operations;
				const suffix = typeof count === "number" && count > 0 ? ` (${count} file${count === 1 ? "" : "s"})` : "";
				const label = isPartial ? "Running" : baseText.startsWith("Error:") ? "Failed" : "Done";
				return textComponent(title(theme, nf.apply, "apply_patch", `${label}${suffix}`));
			}

			const details = result.details as ApplyPatchRenderDetails | undefined;
			const textBlock = result.content.find((block) => block.type === "text");
			const baseText = textBlock?.type === "text" ? textBlock.text : "";
			const files = markFilesSemantic(details?.fileDiffs ?? details?.files ?? [], details?.semantic ?? false);
			const count = details?.filesChanged ?? details?.operations ?? files.length;
			const highlightedRows = details?.highlightedDiffRows;
			const scopedRows =
				details?.diff && details.previewChanges?.length
					? parseUnifiedDiffWithScopes(details.diff, details.previewChanges)
					: undefined;
			const displayRows = mergeScopedDiffRows(highlightedRows, scopedRows);
			const state = context.state as ApplyPatchRenderState;
			state.resultRendered = true;
			scheduleApplyPatchInvalidation(context as { state?: ApplyPatchRenderState; invalidate?: () => void }, false);
			if (isPartial) state.renderedLiveResult = true;
			const diffLineLimit = config.maxDiffLines;

			if (isPartial) {
				if (details?.stage === "validate") {
					return new ApplyPatchDiffView(
						"patch",
						files,
						theme.fg("warning", "Validating patch..."),
						theme,
						config,
						"pending",
						"Validating",
						undefined,
						false,
						undefined,
						undefined,
						"raw",
					);
				}
				if (details?.stage === "apply") {
					if (count > 0) {
						return renderApplyPatchBox(
							theme,
							details.diff,
							files,
							count,
							config,
							"pending",
							"Patching",
							expanded,
							scopedRows,
							diffLineLimit,
						);
					}
					return new ApplyPatchDiffView(
						"patch",
						files,
						theme.fg("warning", "Applying patch..."),
						theme,
						config,
						"pending",
						"Patching",
						undefined,
						false,
						undefined,
						undefined,
						editKindFromFiles(files),
					);
				}
				return new ApplyPatchDiffView(
					"patch",
					files,
					theme.fg("warning", baseText || "Applying patch..."),
					theme,
					config,
					"pending",
					"Patching",
					undefined,
					false,
					undefined,
					undefined,
					editKindFromFiles(files),
				);
			}

			if (baseText.startsWith("Error:")) {
				return new ApplyPatchDiffView(
					"patch",
					files,
					baseText,
					theme,
					config,
					"error",
					"Patch failed",
					undefined,
					false,
					undefined,
					undefined,
					editKindFromFiles(files),
				);
			}

			if (config.renderDiff && details?.diff && details.diff.length > 0) {
				if (count > 0) {
					return renderApplyPatchBox(
						theme,
						details.diff,
						files,
						count,
						config,
						"success",
						undefined,
						expanded,
						displayRows,
						diffLineLimit,
					);
				}
				return renderApplyPatchBox(
					theme,
					details.diff,
					files,
					0,
					config,
					"success",
					undefined,
					expanded,
					displayRows,
					diffLineLimit,
				);
			}

			if (baseText) {
				return new ApplyPatchDiffView(
					"patch",
					files,
					baseText,
					theme,
					config,
					"success",
					undefined,
					undefined,
					false,
					undefined,
					undefined,
					editKindFromFiles(files),
				);
			}

			return new ApplyPatchDiffView(
				"patch",
				files,
				theme.fg("muted", "(no output)"),
				theme,
				config,
				"success",
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				editKindFromFiles(files),
			);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			enforceToolPolicy(pi, config);

			const input = typeof params.input === "string" ? params.input : "";
			const inputKey = patchInputKey(input);
			const semanticInput = isSemanticPatchInput(input);
			executingPatchInputs.add(inputKey);
			completedPatchInputs.delete(inputKey);

			try {
				if (signal?.aborted) {
					return errorResult("apply_patch aborted before validation.");
				}

				const progress = parsePatchInputProgress(input);
				const shouldDryRun = config.validateBeforeApply || config.syntaxHighlight;
				let dryRun: { stdout: string; stderr: string } | undefined;
				let previewDiff = "";
				let previewChanges: ApplyPatchPreviewChange[] = [];

				if (shouldDryRun) {
					if (config.validateBeforeApply) {
						onUpdate?.({
							content: [{ type: "text", text: "Validating apply_patch payload..." }],
							details: {
								stage: "validate",
								operations: progress.totalOperations,
								files: progress.files,
								semantic: semanticInput,
							},
						});
					}

					const dryRunResult = await runApplyPatch(ctx.cwd, input, true, signal).catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						return { error: message } as const;
					});
					if ("error" in dryRunResult) {
						return errorResult(dryRunResult.error, {
							stage: "validate",
						});
					}
					dryRun = dryRunResult;
				}

				if (config.richRender && config.renderDiff && (!dryRun || semanticInput)) {
					const preview = await runApplyPatchPreview(ctx.cwd, input, signal).catch(() => undefined);
					if (preview?.status === "valid" && preview.diff) {
						previewDiff = preview.diff.trim();
						previewChanges = preview.changes ?? [];
					} else if (preview?.status === "invalid" && preview.error) {
						return errorResult(preview.error, { stage: "validate" });
					}
				}

				if (signal?.aborted) {
					return errorResult("apply_patch aborted before applying changes.");
				}

				const prePatchShikiSources =
					config.richRender && config.renderDiff && config.syntaxHighlight
						? collectPrePatchShikiSources(ctx.cwd, progress.files)
						: [];

				onUpdate?.({
					content: [{ type: "text", text: "Applying patch..." }],
					details: {
						stage: "apply",
						operations: progress.totalOperations,
						files: progress.files,
						semantic: semanticInput,
						...(config.richRender && config.renderDiff
							? { diff: dryRun?.stdout ?? previewDiff, previewChanges }
							: {}),
					},
				});

				const applied = await runApplyPatch(ctx.cwd, input, false, signal).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					return { error: message } as const;
				});
				if ("error" in applied) {
					return errorResult(applied.error, {
						stage: "apply",
						semantic: semanticInput,
						...(dryRun ? { diff: dryRun.stdout } : {}),
					});
				}

				const filesChanged = parseApplyPatchSummary(applied.stdout);
				const diff = dryRun?.stdout.trim() ?? previewDiff;
				const highlightedDiffRows =
					config.richRender && config.renderDiff && diff.length > 0
						? config.syntaxHighlight
							? await buildHighlightedDiffRows(
									diff,
									prePatchShikiSources,
									collectPostPatchShikiSources(ctx.cwd, progress.files),
									signal,
								)
							: parseUnifiedDiff(diff)
						: [];
				if (config.recordUsageEntry) {
					pi.appendEntry(APPLY_PATCH_USAGE_ENTRY, {
						used: true,
						modelId: ctx.model?.id,
						timestamp: Date.now(),
					});
				}

				for (const file of progress.files) {
					const targets = file.moveTo
						? [
								{ path: resolve(ctx.cwd, file.path), operation: "delete" },
								{ path: resolve(ctx.cwd, file.moveTo), operation: "add" },
							]
						: [
								{
									path: resolve(ctx.cwd, file.path),
									operation: file.operation,
								},
							];
					for (const target of targets) {
						pi.events.emit("apply-patch:file-modified", target);
						pi.events.emit("context-guard:file-modified", {
							path: target.path,
						});
					}
				}

				return makeResult("ct apply-patch", ctx.cwd, applied.stdout, applied.stderr, {
					filesChanged,
					operations: progress.totalOperations,
					semantic: semanticInput,
					...(config.richRender && config.renderDiff ? { diff, highlightedDiffRows, previewChanges } : {}),
					fileDiffs: progress.files,
				});
			} finally {
				executingPatchInputs.delete(inputKey);
				rememberCompletedPatchInput(completedPatchInputs, inputKey);
			}
		},
	} as any);
}
