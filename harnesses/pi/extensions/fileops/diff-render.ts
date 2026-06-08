// @ts-nocheck
import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { diffChars } from "diff";
import { clampAnsiLine, paintAnsiBackgroundRow, sgrResetsBackground } from "../shared/tui";
import { columnCountForWidth, columnWidthFor, renderColumns } from "./columns.ts";
export type RenderTheme = {
	fg(role: string, text: string): string;
	bg?: (role: string, text: string) => string;
	getBgAnsi?: (role: string) => string | undefined;
	getFgAnsi?: (role: string) => string | undefined;
	bold(text: string): string;
	inverse?: (text: string) => string;
	getLangIcon?: (language: string | undefined) => string;
	tree?: { last: string; branch: string; vertical: string };
	sep?: { dot: string };
};

export type DiffRenderRow = {
	kind: "add" | "remove" | "context" | "hunk";
	oldLine: number | null;
	newLine: number | null;
	content: string;
	path?: string;
	highlightedContent?: string;
};

export type DiffSectionHeaderRenderer = (
	filePath: string,
	firstChangedLine: number | undefined,
	theme: RenderTheme,
) => string;

const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_RESET = "\x1b[0m";
const ADD_ROW_BG = "\x1b[48;2;20;53;31m";
const REMOVE_ROW_BG = "\x1b[48;2;59;29;36m";
const ADD_WORD_BG = "\x1b[48;2;45;94;60m";
const REMOVE_WORD_BG = "\x1b[48;2;115;55;75m";

export function languageFromPath(filePath?: string): string | undefined {
	if (!filePath) return undefined;
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	if (ext === "ts" || ext === "tsx") return "typescript";
	if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript";
	if (ext === "json") return "json";
	if (ext === "md") return "markdown";
	if (ext === "rs") return "rust";
	if (ext === "py") return "python";
	if (ext === "sh" || ext === "zsh" || ext === "bash") return "bash";
	return ext;
}
const MATCH_BG = "\x1b[48;2;92;78;35m";
const SHIKI_THEME = "github-dark";
const SHIKI_MAX_ROWS = 80;
const SHIKI_MAX_CHARS = 24_000;
const highlightCache = new Map<string, string[]>();

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
	const match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex);
	if (!match) return undefined;
	const value = match[1]!;
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	};
}

function ansiFg(hex: string | undefined, text: string): string {
	if (!hex || text.length === 0) return text;
	const rgb = hexToRgb(hex);
	if (!rgb) return text;
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}${ANSI_RESET}`;
}

async function codeToAnsiRows(code: string, language: string): Promise<string[]> {
	const shiki = await import("shiki");
	const lines = await shiki.codeToTokensBase(code, { lang: language as any, theme: SHIKI_THEME as any });
	const theme = (await shiki.getSingletonHighlighter()).getTheme(SHIKI_THEME as any);
	return lines.map((line) => line.map((token) => ansiFg(token.color ?? theme.fg, token.content)).join(""));
}
function normalizeDiffHeaderPath(rawPath: string): string | undefined {
	const normalized = rawPath.trim().replace(/^a\//, "").replace(/^b\//, "");
	return normalized && normalized !== "/dev/null" ? normalized.replace(/\\/g, "/") : undefined;
}

function parseUnifiedDiff(diff: string): DiffRenderRow[] {
	const rows: DiffRenderRow[] = [];
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
		const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(rawLine);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			rows.push({
				kind: "hunk",
				oldLine: null,
				newLine: null,
				content: rawLine,
				path: newPath ?? oldPath ?? currentPath,
			});
			continue;
		}
		if (oldLine === null || newLine === null || rawLine.startsWith("\\")) continue;
		if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			rows.push({ kind: "remove", oldLine, newLine: null, content: rawLine.slice(1), path: oldPath ?? currentPath });
			oldLine++;
		} else if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			rows.push({ kind: "add", oldLine: null, newLine, content: rawLine.slice(1), path: newPath ?? currentPath });
			newLine++;
		} else if (rawLine.startsWith(" ")) {
			rows.push({
				kind: "context",
				oldLine,
				newLine,
				content: rawLine.slice(1),
				path: newPath ?? oldPath ?? currentPath,
			});
			oldLine++;
			newLine++;
		}
	}
	return rows;
}

function stripBackgroundSgr(text: string): string {
	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = rawParams.split(";").filter(Boolean);
		if (params.length === 0) return sequence;
		const kept: string[] = [];
		for (let index = 0; index < params.length; index++) {
			const param = params[index];
			if (param === "49") continue;
			if (param === "48") {
				const mode = params[index + 1];
				if (mode === "2") index += 4;
				else if (mode === "5") index += 2;
				else index += 1;
				continue;
			}
			kept.push(param);
		}
		return kept.length === 0 ? "" : `\x1b[${kept.join(";")}m`;
	});
}

async function highlightDiffContent(content: string, filePath: string | undefined): Promise<string> {
	return (await highlightCodeRows(filePath, [content]))[0] ?? content.replace(/\t/g, "  ");
}

function visibleText(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function changedRangesForVisiblePair(
	oldText: string,
	newText: string,
): {
	oldRanges: Array<[number, number]>;
	newRanges: Array<[number, number]>;
} {
	const parts = diffChars(oldText, newText);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oldOffset = 0;
	let newOffset = 0;
	for (const part of parts) {
		const length = part.value.length;
		if (part.removed) {
			oldRanges.push([oldOffset, oldOffset + length]);
			oldOffset += length;
		} else if (part.added) {
			newRanges.push([newOffset, newOffset + length]);
			newOffset += length;
		} else {
			oldOffset += length;
			newOffset += length;
		}
	}
	return { oldRanges, newRanges };
}

export function applyVisibleRangeBackground(
	ansiText: string,
	ranges: readonly [number, number][],
	background: string,
): string {
	if (ranges.length === 0 || ansiText.replace(ANSI_PATTERN, "").length === 0) return ansiText;
	let output = "";
	let visibleOffset = 0;
	let activeSgr = "";
	let activeRange = false;
	let index = 0;
	for (const match of ansiText.matchAll(ANSI_SGR_PATTERN)) {
		const start = match.index ?? 0;
		const text = ansiText.slice(index, start);
		for (const char of text) {
			if (
				!activeRange &&
				ranges.some(([rangeStart, rangeEnd]) => rangeStart === visibleOffset && rangeEnd > rangeStart)
			) {
				output += background;
				activeRange = true;
			}
			output += char;
			visibleOffset += char.length;
			if (activeRange && ranges.some(([, rangeEnd]) => rangeEnd === visibleOffset)) {
				output += `${ANSI_RESET}${activeSgr}`;
				activeRange = false;
			}
		}
		const sequence = match[0];
		const rawParams = match[1] ?? "";
		activeSgr = sgrResetsBackground(rawParams) ? "" : `${activeSgr}${sequence}`;
		output += sequence;
		if (activeRange && sgrResetsBackground(rawParams)) output += background;
		index = start + sequence.length;
	}
	for (const char of ansiText.slice(index)) {
		if (
			!activeRange &&
			ranges.some(([rangeStart, rangeEnd]) => rangeStart === visibleOffset && rangeEnd > rangeStart)
		) {
			output += background;
			activeRange = true;
		}
		output += char;
		visibleOffset += char.length;
		if (activeRange && ranges.some(([, rangeEnd]) => rangeEnd === visibleOffset)) {
			output += `${ANSI_RESET}${activeSgr}`;
			activeRange = false;
		}
	}
	if (activeRange) output += `${ANSI_RESET}${activeSgr}`;
	return output;
}

function changedLength(oldText: string, newText: string): number {
	return diffChars(oldText, newText).reduce(
		(total, part) => total + (part.added || part.removed ? part.value.length : 0),
		0,
	);
}

function lineSimilarity(oldText: string, newText: string): number {
	const maxLength = Math.max(oldText.trim().length, newText.trim().length);
	if (maxLength === 0) return 1;
	return 1 - changedLength(oldText.trim(), newText.trim()) / maxLength;
}

function selectSingleBestPair(
	oldLineNumbers: readonly number[],
	newLineNumbers: readonly number[],
	rowsByOldLine: ReadonlyMap<number, DiffRenderRow>,
	rowsByNewLine: ReadonlyMap<number, DiffRenderRow>,
): string | undefined {
	let best: { key: string; score: number } | undefined;
	for (const oldLine of oldLineNumbers) {
		const oldRow = rowsByOldLine.get(oldLine);
		if (!oldRow) continue;
		for (const newLine of newLineNumbers) {
			const newRow = rowsByNewLine.get(newLine);
			if (!newRow) continue;
			const score = lineSimilarity(oldRow.content, newRow.content);
			if (!best || score > best.score) best = { key: `${oldLine}:${newLine}`, score };
		}
	}
	return best && best.score >= 0.65 ? best.key : undefined;
}

function indexChangedRows(rows: readonly DiffRenderRow[]): {
	rowsByOldLine: Map<number, DiffRenderRow>;
	rowsByNewLine: Map<number, DiffRenderRow>;
} {
	const rowsByOldLine = new Map<number, DiffRenderRow>();
	const rowsByNewLine = new Map<number, DiffRenderRow>();
	for (const row of rows) {
		if (row.kind === "remove" && row.oldLine !== null) rowsByOldLine.set(row.oldLine, row);
		if (row.kind === "add" && row.newLine !== null) rowsByNewLine.set(row.newLine, row);
	}
	return { rowsByOldLine, rowsByNewLine };
}

function addPendingPairs(
	pairs: Set<string>,
	pendingRemovals: readonly number[],
	pendingAdditions: readonly number[],
	rowsByOldLine: ReadonlyMap<number, DiffRenderRow>,
	rowsByNewLine: ReadonlyMap<number, DiffRenderRow>,
): void {
	if (pendingRemovals.length === pendingAdditions.length) {
		for (let index = 0; index < pendingRemovals.length; index++) {
			pairs.add(`${pendingRemovals[index]}:${pendingAdditions[index]}`);
		}
		return;
	}
	if (pendingRemovals.length !== 1 && pendingAdditions.length !== 1) return;
	const pair = selectSingleBestPair(pendingRemovals, pendingAdditions, rowsByOldLine, rowsByNewLine);
	if (pair) pairs.add(pair);
}

function diffComPairedChangeLines(_diff: string, rows: readonly DiffRenderRow[]): Set<string> {
	const pairs = new Set<string>();
	const { rowsByOldLine, rowsByNewLine } = indexChangedRows(rows);
	let pendingRemovals: number[] = [];
	let pendingAdditions: number[] = [];

	for (const row of rows) {
		if (row.kind === "remove" && row.oldLine !== null) {
			pendingRemovals.push(row.oldLine);
		} else if (row.kind === "add" && row.newLine !== null) {
			pendingAdditions.push(row.newLine);
		} else {
			addPendingPairs(pairs, pendingRemovals, pendingAdditions, rowsByOldLine, rowsByNewLine);
			pendingRemovals = [];
			pendingAdditions = [];
		}
	}
	addPendingPairs(pairs, pendingRemovals, pendingAdditions, rowsByOldLine, rowsByNewLine);

	return pairs;
}

function applyWordDiffPair(removed: DiffRenderRow, added: DiffRenderRow): void {
	const removedContent = removed.highlightedContent ?? removed.content.replace(/\t/g, "  ");
	const addedContent = added.highlightedContent ?? added.content.replace(/\t/g, "  ");
	const { oldRanges, newRanges } = changedRangesForVisiblePair(visibleText(removedContent), visibleText(addedContent));
	removed.highlightedContent = applyVisibleRangeBackground(removedContent, oldRanges, REMOVE_WORD_BG);
	added.highlightedContent = applyVisibleRangeBackground(addedContent, newRanges, ADD_WORD_BG);
}

function applyWordDiffHighlights(diff: string, rows: DiffRenderRow[]): DiffRenderRow[] {
	const output = rows.map((row) => ({ ...row }));
	const rowsByOldLine = new Map<number, DiffRenderRow>();
	const rowsByNewLine = new Map<number, DiffRenderRow>();
	for (const row of output) {
		if (row.kind === "remove" && row.oldLine !== null) rowsByOldLine.set(row.oldLine, row);
		if (row.kind === "add" && row.newLine !== null) rowsByNewLine.set(row.newLine, row);
	}
	for (const key of diffComPairedChangeLines(diff, output)) {
		const [oldLineText, newLineText] = key.split(":");
		const removed = rowsByOldLine.get(Number(oldLineText));
		const added = rowsByNewLine.get(Number(newLineText));
		if (removed && added) applyWordDiffPair(removed, added);
	}
	return output;
}
export function highlightCodeRowsSync(filePath: string | undefined, rows: readonly string[]): string[] {
	const language = languageFromPath(filePath);
	const normalized = rows.map((row) => row.replace(/\t/g, "  "));
	if (!language) return normalized;
	try {
		const highlighted = highlightCode(normalized.join("\n"), language);
		return normalized.map((fallback, index) => stripBackgroundSgr(highlighted[index] ?? fallback));
	} catch {
		return normalized;
	}
}

export async function highlightCodeRows(filePath: string | undefined, rows: readonly string[]): Promise<string[]> {
	const language = languageFromPath(filePath);
	const normalized = rows.map((row) => row.replace(/\t/g, "  "));
	if (!language || normalized.length === 0) return normalized;
	if (normalized.length > SHIKI_MAX_ROWS || normalized.join("\n").length > SHIKI_MAX_CHARS) {
		return highlightCodeRowsSync(filePath, rows);
	}
	const code = normalized.join("\n");
	const cacheKey = `${SHIKI_THEME}\0${language}\0${code}`;
	const cached = highlightCache.get(cacheKey);
	if (cached) return cached;
	try {
		const rows = (await codeToAnsiRows(code, language)).map(stripBackgroundSgr);
		const highlighted = rows.length === normalized.length ? rows : rows.slice(0, normalized.length);
		const result = normalized.map((fallback, index) => highlighted[index] ?? fallback);
		highlightCache.set(cacheKey, result);
		if (highlightCache.size > 128) highlightCache.delete(highlightCache.keys().next().value!);
		return result;
	} catch {
		return normalized;
	}
}

export function highlightSearchMatches(ansiText: string, pattern: string): string {
	if (!pattern) return ansiText;
	const plain = ansiText.replace(ANSI_PATTERN, "");
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "gi");
	} catch {
		regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
	}
	const ranges: Array<[number, number]> = [];
	for (const match of plain.matchAll(regex)) {
		if (match[0].length === 0) continue;
		const start = match.index ?? 0;
		ranges.push([start, start + match[0].length]);
	}
	return applyVisibleRangeBackground(ansiText, ranges, MATCH_BG);
}

export async function buildHighlightedDiffRows(diff: string): Promise<DiffRenderRow[]> {
	const parsedRows = parseUnifiedDiff(diff);
	const rows = await Promise.all(
		parsedRows.map(async (row) =>
			row.kind === "hunk" ? row : { ...row, highlightedContent: await highlightDiffContent(row.content, row.path) },
		),
	);
	return applyWordDiffHighlights(diff, rows);
}

function rowBackground(kind: DiffRenderRow["kind"]): string | undefined {
	if (kind === "add") return ADD_ROW_BG;
	if (kind === "remove") return REMOVE_ROW_BG;
	return undefined;
}

function paintDiffRow(
	line: string,
	width: number,
	theme: RenderTheme,
	backgroundRole: "toolPendingBg" | "toolDiffAdded" | "toolDiffRemoved",
	backgroundAnsi?: string,
): string {
	const painted = paintAnsiBackgroundRow(line, width, backgroundAnsi);
	if (backgroundAnsi) return painted;
	const padded = truncateToWidth(line, width, "", true);
	return theme.bg ? theme.bg(backgroundRole, padded) : padded;
}

function diffStats(diff: string): { added: number; removed: number; hunks: number } {
	let added = 0;
	let removed = 0;
	let hunks = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) hunks++;
		else if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed, hunks };
}

function formatDiffStatsLine(diff: string, theme: RenderTheme): string {
	const stats = diffStats(diff);
	return `${theme.fg("dim", "<")}${theme.fg("toolDiffAdded", `+${stats.added}`)}${theme.fg("dim", " / ")}${theme.fg("toolDiffRemoved", `-${stats.removed}`)}${theme.fg("dim", ` / ${stats.hunks} hunk${stats.hunks === 1 ? "" : "s"}>`)}`;
}

function clampRenderedLine(line: string, width: number): string {
	return clampAnsiLine(line, width);
}
function diffLineNumberWidth(rows: DiffRenderRow[]): number {
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
	if (wrapped.length <= maxRows) return wrapped.map((line) => truncateToWidth(line, width, "", true));
	return wrapped
		.slice(0, maxRows)
		.map((line, index) => truncateToWidth(line, width, index === maxRows - 1 ? "…" : "", true));
}

function diffContentForRow(row: DiffRenderRow): string {
	return row.highlightedContent ?? row.content.replace(/\t/g, "  ");
}

function defaultDiffSectionHeader(filePath: string, firstChangedLine: number | undefined, theme: RenderTheme): string {
	const icon = theme.getLangIcon?.(languageFromPath(filePath));
	const line = firstChangedLine === undefined ? "" : `:${firstChangedLine}`;
	return `✓ ${theme.fg("toolTitle", theme.bold("Edit:"))} ${theme.fg("accent", `${icon ? `${icon} ` : ""}${filePath}${line}`)}`;
}

type DiffFileSection = {
	path: string;
	rows: DiffRenderRow[];
};

function groupDiffRowsByFile(rows: readonly DiffRenderRow[]): DiffFileSection[] {
	const sections: DiffFileSection[] = [];
	let current: DiffFileSection | undefined;
	for (const row of rows) {
		const path = row.path ?? current?.path;
		if (!path) continue;
		if (!current || current.path !== path) {
			current = { path, rows: [] };
			sections.push(current);
		}
		current.rows.push(row);
	}
	return sections;
}

function firstChangedLine(rows: readonly DiffRenderRow[]): number | undefined {
	for (const row of rows) {
		if (row.kind === "add" && row.newLine !== null) return row.newLine;
		if (row.kind === "remove" && row.oldLine !== null) return row.oldLine;
	}
	return undefined;
}

function sectionDiffStats(rows: readonly DiffRenderRow[]): { added: number; removed: number; hunks: number } {
	let added = 0;
	let removed = 0;
	let hunks = 0;
	for (const row of rows) {
		if (row.kind === "hunk") hunks++;
		else if (row.kind === "add") added++;
		else if (row.kind === "remove") removed++;
	}
	return { added, removed, hunks };
}

function formatSectionDiffStatsLine(rows: readonly DiffRenderRow[], theme: RenderTheme): string {
	const stats = sectionDiffStats(rows);
	return `${theme.fg("dim", "<")}${theme.fg("toolDiffAdded", `+${stats.added}`)}${theme.fg("dim", " / ")}${theme.fg("toolDiffRemoved", `-${stats.removed}`)}${theme.fg("dim", ` / ${stats.hunks} hunk${stats.hunks === 1 ? "" : "s"}>`)}`;
}

function renderDiffOmittedLine(remaining: number, width: number, theme: RenderTheme): string {
	return paintDiffRow(
		theme.fg("muted", `... (${remaining} more diff lines, `) +
			keyHint("app.tools.expand", "to expand") +
			theme.fg("muted", ")"),
		width,
		theme,
		"toolPendingBg",
		theme.getBgAnsi?.("toolPendingBg"),
	);
}

function renderDiffSectionRows(
	section: DiffFileSection,
	sectionIndex: number,
	theme: RenderTheme,
	width: number,
	headerRenderer: DiffSectionHeaderRenderer,
	includeHeader: boolean,
): string[] {
	const rendered: string[] = [];
	const numberWidth = diffLineNumberWidth(section.rows);
	const gutterWidth = numberWidth + 5;
	const codeWidth = Math.max(8, width - gutterWidth);
	if (includeHeader || sectionIndex > 0) {
		rendered.push(
			paintDiffRow(
				headerRenderer(section.path, firstChangedLine(section.rows), theme),
				width,
				theme,
				"toolPendingBg",
				theme.getBgAnsi?.("toolPendingBg"),
			),
		);
	}
	rendered.push(
		paintDiffRow(
			formatSectionDiffStatsLine(section.rows, theme),
			width,
			theme,
			"toolPendingBg",
			theme.getBgAnsi?.("toolPendingBg"),
		),
	);
	const wrapLimit = diffWrapRows(width);
	for (const row of section.rows) {
		if (row.kind === "hunk") continue;
		const kindColor = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "dim";
		const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
		const lineNumber = row.kind === "remove" ? row.oldLine : row.newLine;
		const prefix = `  ${theme.fg(kindColor, String(lineNumber ?? "").padStart(numberWidth, " "))} ${theme.fg(kindColor, sign)} `;
		const continuation = `  ${" ".repeat(numberWidth)}   `;
		const bodyLines = wrapDiffContent(diffContentForRow(row), codeWidth, wrapLimit);
		const rowBg = rowBackground(row.kind);
		const backgroundRole =
			row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : "toolPendingBg";
		const backgroundAnsi = rowBg ?? theme.getBgAnsi?.("toolPendingBg");
		for (const [bodyIndex, body] of bodyLines.entries()) {
			rendered.push(
				paintDiffRow(`${bodyIndex === 0 ? prefix : continuation}${body}`, width, theme, backgroundRole, backgroundAnsi),
			);
		}
	}
	return rendered;
}

function renderDiffRows(
	diff: string,
	rows: DiffRenderRow[] | undefined,
	theme: RenderTheme,
	width: number,
	expanded: boolean,
	headerRenderer: DiffSectionHeaderRenderer = defaultDiffSectionHeader,
): string[] {
	const parsedRows = rows ?? parseUnifiedDiff(diff);
	const sections = groupDiffRowsByFile(parsedRows);
	if (sections.length === 0) {
		return [
			paintDiffRow(formatDiffStatsLine(diff, theme), width, theme, "toolPendingBg", theme.getBgAnsi?.("toolPendingBg")),
		];
	}
	const columnCount = columnCountForWidth(width, sections.length);
	if (columnCount > 1) {
		const columnWidth = columnWidthFor(width, columnCount);
		const blocks = sections.map((section, sectionIndex) => {
			const rendered = renderDiffSectionRows(section, sectionIndex, theme, columnWidth, headerRenderer, true);
			if (expanded || rendered.length <= 40) return rendered;
			return [...rendered.slice(0, 40), renderDiffOmittedLine(rendered.length - 40, columnWidth, theme)];
		});
		return renderColumns(blocks, width);
	}
	const rendered = sections.flatMap((section, sectionIndex) =>
		renderDiffSectionRows(section, sectionIndex, theme, width, headerRenderer, false),
	);
	const limit = expanded ? rendered.length : 40;
	const visible = rendered.slice(0, limit);
	if (rendered.length > limit) visible.push(renderDiffOmittedLine(rendered.length - limit, width, theme));
	return visible;
}

export class EditDiffView {
	private renderedCache?: { width: number; expanded: boolean; lines: string[] };

	constructor(
		private readonly diff: string,
		private readonly rows: DiffRenderRow[] | undefined,
		private readonly expanded: boolean,
		private readonly theme: RenderTheme,
		private readonly headerRenderer: DiffSectionHeaderRenderer = defaultDiffSectionHeader,
	) {}

	invalidate() {
		this.renderedCache = undefined;
	}

	render(width: number): string[] {
		if (this.renderedCache?.width === width && this.renderedCache.expanded === this.expanded) {
			return this.renderedCache.lines;
		}
		const lines = renderDiffRows(this.diff, this.rows, this.theme, width, this.expanded, this.headerRenderer).map(
			(line) => clampRenderedLine(line, width),
		);
		this.renderedCache = { width, expanded: this.expanded, lines };
		return lines;
	}
}
