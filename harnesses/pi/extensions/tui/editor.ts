import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminalRows } from "../shared/terminal";
import { ANSI_RESET, fillBackgroundLine } from "./render-lines";

const CUSTOM_EDITOR_ORIGINAL_RENDER = Symbol.for("agents.polishedTui.customEditorOriginalRender");

type AutocompleteEditorInternals = {
	autocompleteList?: Pick<Component, "render">;
	isShowingAutocomplete?: () => boolean;
};

type TransformableEditor = AutocompleteEditorInternals & {
	getMode?: () => string;
	transformEditorLine?: (line: string) => string;
};

type EditorChrome = {
	topRight?: string;
	bottomRight?: string;
};

type EditorChromeProvider = (width: number, theme: Theme, options: { modeReserve: number }) => EditorChrome;

export interface EditorSessionIdentity {
	label?: string;
	name?: string;
	color?: string;
}

type UiPatchState = { currentUiTheme?: Theme };
const globalPatchState = globalThis as typeof globalThis & {
	__agentsPolishedTuiState?: UiPatchState;
};
globalPatchState.__agentsPolishedTuiState ??= {};
const patchState = globalPatchState.__agentsPolishedTuiState;
let cachedSkillNames: string[] = [];
let workingActive = false;
let workingFrame = 0;
let editorSessionIdentityProvider: (() => EditorSessionIdentity | undefined) | undefined;

const WORKING_WORD = "Working";
const WORKING_SHINE_WIDTH = 3;
const WORKING_PERCOLATION_MS = 80;
const RAIL_PULSE_MS = 2000;
const RGB_FALLBACK: Rgb = [0xff, 0xff, 0xff];
const EDITOR_BG_DARKEN = 0.78;
const MODE_LABEL_RESERVE = 9;

type Rgb = [number, number, number];
let editorChromeProvider: EditorChromeProvider | undefined;

export function setEditorTheme(uiTheme: Theme): void {
	patchState.currentUiTheme = uiTheme;
}

export function setCachedSkillNames(names: readonly string[]): void {
	cachedSkillNames = [...new Set(names.filter(Boolean))].sort();
}

export function setCachedSkillNamesForTest(names: readonly string[]): void {
	setCachedSkillNames(names);
}

export function setWorkingAnimationState(active: boolean, frame = workingFrame): void {
	workingActive = active;
	workingFrame = frame;
}

export function advanceWorkingAnimationFrame(): void {
	workingFrame++;
}

export function setWorkingAnimationForTest(active: boolean, frame = 0): void {
	setWorkingAnimationState(active, frame);
}

export function setEditorChromeProvider(provider: EditorChromeProvider | undefined): void {
	editorChromeProvider = provider;
}

export function setEditorSessionIdentityProvider(
	provider: (() => EditorSessionIdentity | undefined) | undefined,
): void {
	editorSessionIdentityProvider = provider;
}

function isStaleCtxError(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).includes("ctx is stale");
}

function getEditorSessionIdentity(): EditorSessionIdentity | undefined {
	try {
		return editorSessionIdentityProvider?.();
	} catch (error) {
		if (!isStaleCtxError(error)) throw error;
		editorSessionIdentityProvider = undefined;
		return undefined;
	}
}

function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if ([...text].length <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	return `${[...text].slice(0, maxWidth - 1).join("")}…`;
}

function ansi256ToRgb(code: number): Rgb {
	if (code < 16) {
		const base: Rgb[] = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		];
		return base[code] ?? RGB_FALLBACK;
	}
	if (code >= 16 && code <= 231) {
		const n = code - 16;
		const r = Math.floor(n / 36);
		const g = Math.floor((n % 36) / 6);
		const b = n % 6;
		const scale = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		return [scale(r), scale(g), scale(b)];
	}
	const gray = 8 + (code - 232) * 10;
	return [gray, gray, gray];
}

function colorAnsi(uiTheme: Theme, color: string): string | undefined {
	const withGetter = uiTheme as Theme & { getFgAnsi?: (color: string) => string };
	if (withGetter.getFgAnsi) return withGetter.getFgAnsi(color);
	const sample = uiTheme.fg(color as never, "x");
	const marker = sample.indexOf("x");
	return marker >= 0 ? sample.slice(0, marker) : undefined;
}

function colorRgb(uiTheme: Theme, color: string): Rgb {
	const ansi = colorAnsi(uiTheme, color);
	const truecolor = ansi?.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];

	const color256 = ansi?.match(/\x1b\[38;5;(\d+)m/);
	if (color256) return ansi256ToRgb(Number(color256[1]));

	return RGB_FALLBACK;
}

function scaleRgb([r, g, b]: Rgb, factor: number): Rgb {
	const scale = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
	return [scale(r), scale(g), scale(b)];
}

function rgbFg([r, g, b]: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

function rgbBg([r, g, b]: Rgb): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

function parseHexRgb(color: string): Rgb | undefined {
	const match = color.match(/^#?([0-9a-fA-F]{6})$/);
	if (!match) return undefined;
	const hex = match[1]!;
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
	];
}

function identityRailGlyph(uiTheme: Theme, color: string): string {
	const rgb = parseHexRgb(color);
	if (rgb) return `${rgbFg(rgb)}▐${ANSI_RESET}`;
	return uiTheme.fg(color as never, "▐");
}

function triangleWave(frame: number, periodMs: number, lo: number, hi: number): number {
	const elapsedMs = frame * WORKING_PERCOLATION_MS;
	const t = (elapsedMs % periodMs) / periodMs;
	const tri = 1 - Math.abs(2 * t - 1);
	return lo + tri * (hi - lo);
}

function modeColor(mode: string | undefined): string {
	if (mode === "insert") return "success";
	if (mode === "visual") return "accent";
	return "syntaxFunction";
}

function renderWorkingWord(uiTheme: Theme, color: string, frame: number): string {
	const base = scaleRgb(colorRgb(uiTheme, color), 0.55);
	const shine = scaleRgb(colorRgb(uiTheme, color), 1.55);
	const step = Math.floor((frame * WORKING_PERCOLATION_MS) / WORKING_PERCOLATION_MS);
	const chars = [...WORKING_WORD];
	const cycle = chars.length + WORKING_SHINE_WIDTH;
	const pos = step % cycle;

	return chars
		.map((ch, index) => {
			const inShine = index >= pos - WORKING_SHINE_WIDTH && index < pos;
			return `${rgbFg(inShine ? shine : base)}${ch}`;
		})
		.join("");
}

function workingHeaderSegment(uiTheme: Theme, color: string): string {
	if (!workingActive) return "";
	const label = renderWorkingWord(uiTheme, color, workingFrame);
	return `${label}${rgbFg(scaleRgb(colorRgb(uiTheme, color), 0.85))}…${ANSI_RESET}`;
}

function cleanIdentityPart(value: string | undefined): string | undefined {
	const text = value
		?.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function sessionIdentityText(identity: EditorSessionIdentity | undefined): string | undefined {
	const label = cleanIdentityPart(identity?.label);
	const name = cleanIdentityPart(identity?.name);
	if (label && name) return `${label} ${name}`;
	return label ?? name;
}

function renderIdentityText(uiTheme: Theme, identity: string, identityColor: string | undefined): string {
	if (!identityColor) return uiTheme.fg("dim", identity);
	const rgb = parseHexRgb(identityColor) ?? colorRgb(uiTheme, identityColor);
	return `${rgbFg(scaleRgb(rgb, 0.62))}${identity}${ANSI_RESET}`;
}

function headerLeftSegment(
	width: number,
	uiTheme: Theme,
	color: string,
	identity: string | undefined,
	identityColor: string | undefined,
): string {
	const working = workingHeaderSegment(uiTheme, color);
	if (identity && working) {
		const delimiter = uiTheme.fg("dim", " · ");
		const identityWidth = width - visibleWidth(working) - visibleWidth(delimiter);
		if (identityWidth <= 0) return truncateToWidth(working, width, "");
		const fittedIdentity = renderIdentityText(uiTheme, truncateVisible(identity, identityWidth), identityColor);
		return truncateToWidth(`${fittedIdentity}${delimiter}${working}`, width, "");
	}
	if (identity) return renderIdentityText(uiTheme, truncateVisible(identity, width), identityColor);
	return truncateToWidth(working, width, "");
}

function cachedSkillsSegment(innerWidth: number, uiTheme: Theme): string {
	if (cachedSkillNames.length === 0) return "";
	const label = truncateVisible(`skills: ${cachedSkillNames.join(", ")}`, innerWidth);
	return uiTheme.fg("dim", label);
}

function composeLeftRight(left: string, right: string | undefined, width: number): string {
	if (!right) return truncateToWidth(left, width, "");
	if (!left) return " ".repeat(Math.max(0, width - visibleWidth(right))) + truncateToWidth(right, width, "");

	const maxRightWidth = Math.max(0, width - visibleWidth(left) - 1);
	const fittedRight = truncateToWidth(right, maxRightWidth, "");
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(fittedRight));
	return truncateToWidth(left, width, "") + " ".repeat(gap) + fittedRight;
}

export function renderPolishedEditorForTest(
	editor: TransformableEditor,
	width: number,
	renderBase: (width: number) => string[],
	minTerminalRows: number,
	uiThemeOverride?: Theme,
): string[] {
	const rows = terminalRows();
	if (rows !== undefined && rows < minTerminalRows) return renderBase(width);
	const uiTheme = uiThemeOverride ?? patchState.currentUiTheme;
	if (!uiTheme) return renderBase(width);

	const identity = getEditorSessionIdentity();
	const identityText = sessionIdentityText(identity);
	const secondaryRailColor = cleanIdentityPart(identity?.color);
	const railWidth = 2 + (secondaryRailColor ? 1 : 0);
	const innerWidth = Math.max(1, width - railWidth);
	const rendered = renderBase(innerWidth);
	const isShowingAutocomplete =
		typeof editor.isShowingAutocomplete === "function" ? Boolean(editor.isShowingAutocomplete()) : false;

	if (rendered.length < 2) return renderBase(width);

	const { autocompleteList } = editor;
	const autocompleteCount =
		isShowingAutocomplete && typeof autocompleteList?.render === "function"
			? autocompleteList.render(innerWidth).length
			: 0;
	const editorFrame =
		autocompleteCount > 0 && autocompleteCount < rendered.length ? rendered.slice(0, -autocompleteCount) : rendered;
	const autocompleteLines =
		autocompleteCount > 0 && autocompleteCount < rendered.length ? rendered.slice(-autocompleteCount) : [];

	if (editorFrame.length < 2) return rendered;

	const transformEditorLine: (line: string) => string =
		typeof editor.transformEditorLine === "function"
			? (line: string) => editor.transformEditorLine?.(line) ?? line
			: (line: string) => line;
	const editorLines = editorFrame.slice(1, -1).map(transformEditorLine);
	const mode = typeof editor.getMode === "function" ? editor.getMode() : undefined;
	const railColor = modeColor(mode);
	const modeReserve = typeof editor.getMode === "function" ? MODE_LABEL_RESERVE : 0;
	const statusWidth = Math.max(1, innerWidth - modeReserve);
	const chrome = editorChromeProvider?.(innerWidth, uiTheme, { modeReserve }) ?? {};
	const railPulseFactor = workingActive ? triangleWave(workingFrame, RAIL_PULSE_MS, 0.18, 1.25) : 0;
	const railBg = workingActive ? rgbBg(scaleRgb(colorRgb(uiTheme, railColor), railPulseFactor)) : "";
	const railGap = fillBackgroundLine(uiTheme, "", 1, { darken: EDITOR_BG_DARKEN });
	const secondaryRail = secondaryRailColor ? `${identityRailGlyph(uiTheme, secondaryRailColor)}${ANSI_RESET}` : "";
	const mainRailGlyph = secondaryRailColor ? "▌" : "┃";
	const rail = `${secondaryRail}${railBg}${uiTheme.fg(railColor as never, mainRailGlyph)}\x1b[49m${ANSI_RESET}${railGap}`;
	const lines = [
		composeLeftRight(
			headerLeftSegment(innerWidth, uiTheme, railColor, identityText, secondaryRailColor),
			chrome.topRight,
			innerWidth,
		),
		...editorLines,
		composeLeftRight(cachedSkillsSegment(statusWidth, uiTheme), chrome.bottomRight, statusWidth),
	];

	return [
		...lines.map((line) => `${rail}${fillBackgroundLine(uiTheme, line, innerWidth, { darken: EDITOR_BG_DARKEN })}`),
		...autocompleteLines,
	];
}

export function installEditorComposition(uiTheme: Theme, minTerminalRows = 28): void {
	setEditorTheme(uiTheme);

	// Patch the shared base editor instead of replacing the active editor so
	// Other packages can keep their own editor/autocomplete behavior.
	const prototype = CustomEditor.prototype as unknown as CustomEditor & {
		render(width: number): string[];
	} & Record<symbol, unknown>;
	const originalRender =
		(prototype[CUSTOM_EDITOR_ORIGINAL_RENDER] as ((this: CustomEditor, width: number) => string[]) | undefined) ??
		prototype.render;
	prototype[CUSTOM_EDITOR_ORIGINAL_RENDER] ??= prototype.render;
	prototype.render = function (this: CustomEditor, width: number): string[] {
		return renderPolishedEditorForTest(
			this as unknown as TransformableEditor,
			width,
			(w) => originalRender.call(this, w),
			minTerminalRows,
		);
	};
}
