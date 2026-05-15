import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "./config";
import { emptyGitStatus, type GitStatusSummary } from "./git";
import type { RuntimeInfo } from "./runtime";
import type { UsageSnapshot } from "./usage";

const MIN_CONTEXT_BAR_WIDTH = 12;
const CHARACTERS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1200;
const CONTEXT_BAR_USED = "━";
const CONTEXT_BAR_FREE = "─";

const CONTEXT_SEGMENTS = [
	{ key: "system", color: "#A6E3A1", legend: "s" },
	{ key: "prompt", color: "#F38BA8", legend: "p" },
	{ key: "assistant", color: "#89DCEB", legend: "a" },
	{ key: "thinking", color: "#CBA6F7", legend: "r" },
	{ key: "tools", color: "#F9E2AF", legend: "x" },
] as const;

export type ContextSegmentKey = (typeof CONTEXT_SEGMENTS)[number]["key"];
export type ContextSegments = Readonly<Record<ContextSegmentKey, number>>;
export type WritableContextSegments = Record<ContextSegmentKey, number>;
export type ContextSlice = Readonly<{ key: ContextSegmentKey; tokens: number }>;
export type ContextBreakdown = Readonly<{ segments: ContextSegments; slices: readonly ContextSlice[] }>;

export type FooterRenderState = GitStatusSummary & {
	modelLabel: string;
	providerLabel: string;
	thinkingLevel?: string;
	contextPercent: number | null;
	contextUsed: number;
	contextTotal: number;
	contextSegments: ContextSegments;
	contextSlices: readonly ContextSlice[];
	contextPulseSliceIndexes: readonly number[];
	contextPulseFrame: number;
	contextUsageEstimated: boolean;
	tokenLabel: string;
	costLabel: string;
	hasTokens: boolean;
	hasCost: boolean;
	runtime?: RuntimeInfo;
	usage?: UsageSnapshot | null;
	usageLines?: string[];
};

export function emptyContextSegments(): WritableContextSegments {
	return {
		system: 0,
		prompt: 0,
		assistant: 0,
		thinking: 0,
		tools: 0,
	};
}

export function emptyFooterState(): FooterRenderState {
	return {
		modelLabel: "no-model",
		providerLabel: "Unknown",
		thinkingLevel: undefined,
		contextPercent: null,
		contextUsed: 0,
		contextTotal: 0,
		contextSegments: emptyContextSegments(),
		contextSlices: [],
		contextPulseSliceIndexes: [],
		contextPulseFrame: 0,
		contextUsageEstimated: false,
		tokenLabel: "↑0 ↓0",
		costLabel: "$0.00",
		hasTokens: false,
		hasCost: false,
		runtime: undefined,
		usage: null,
		usageLines: undefined,
		...emptyGitStatus(),
	};
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		return m % 1 === 0 ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

function formatCwdLabel(cwd: string, cwdIcon: string): string {
	let pwd = cwd;
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
	return cwdIcon ? `${cwdIcon} ${pwd}` : pwd;
}

function fitFooterSegment(width: number, variants: string[]): string {
	const safeWidth = Math.max(1, width);
	for (const variant of variants) {
		if (visibleWidth(variant) <= safeWidth) return variant;
	}
	return truncateToWidth(variants[variants.length - 1] || "", safeWidth);
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

function contentRecords(content: unknown): readonly Record<string, unknown>[] {
	return Array.isArray(content)
		? content.filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
		: [];
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	return contentRecords(content)
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

function imageCount(content: unknown): number {
	return contentRecords(content).filter((part) => part.type === "image").length;
}

function estimateContentTokens(content: unknown): number {
	return estimateTextTokens(textFromContent(content)) + imageCount(content) * IMAGE_TOKEN_ESTIMATE;
}

function estimateToolCallTokens(part: Record<string, unknown>): number {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});
	return estimateTextTokens(`${name}${input}`);
}

function addContextSlice(slices: ContextSlice[], key: ContextSegmentKey, tokens: number): void {
	if (tokens <= 0) return;
	const last = slices[slices.length - 1];
	if (last?.key === key) {
		slices[slices.length - 1] = { key, tokens: last.tokens + tokens };
		return;
	}
	slices.push({ key, tokens });
}

function addContextTokens(
	segments: WritableContextSegments,
	slices: ContextSlice[],
	key: ContextSegmentKey,
	tokens: number,
): void {
	if (tokens <= 0) return;
	segments[key] += tokens;
	addContextSlice(slices, key, tokens);
}

function addAssistantTokens(segments: WritableContextSegments, slices: ContextSlice[], content: unknown): void {
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			addContextTokens(segments, slices, "assistant", estimateTextTokens(part.text));
		}
		if (part.type === "thinking" && typeof part.thinking === "string") {
			addContextTokens(segments, slices, "thinking", estimateTextTokens(part.thinking));
		}
		if (part.type === "toolCall") {
			addContextTokens(segments, slices, "assistant", estimateToolCallTokens(part));
		}
	}
}

export function estimateContextBreakdown(messages: readonly unknown[], systemPrompt: string): ContextBreakdown {
	const segments = emptyContextSegments();
	const slices: ContextSlice[] = [];
	addContextTokens(segments, slices, "system", estimateTextTokens(systemPrompt));

	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;

		if (record.role === "user" || record.role === "custom") {
			addContextTokens(segments, slices, "prompt", estimateContentTokens(record.content));
		} else if (record.role === "assistant") {
			addAssistantTokens(segments, slices, record.content);
		} else if (record.role === "toolResult") {
			addContextTokens(segments, slices, "tools", estimateContentTokens(record.content));
		} else if (record.role === "bashExecution") {
			addContextTokens(
				segments,
				slices,
				"tools",
				estimateTextTokens(`${record.command ?? ""}${record.output ?? ""}`),
			);
		} else if (record.role === "branchSummary" || record.role === "compactionSummary") {
			addContextTokens(segments, slices, "system", estimateTextTokens(String(record.summary ?? "")));
		}
	}

	return { segments, slices };
}

export function estimateContextSegments(messages: readonly unknown[], systemPrompt: string): ContextSegments {
	return estimateContextBreakdown(messages, systemPrompt).segments;
}

function segmentTotal(segments: ContextSegments): number {
	return CONTEXT_SEGMENTS.reduce((total, segment) => total + segments[segment.key], 0);
}

function allocateProportionally(values: readonly number[], columns: number): number[] {
	if (columns <= 0) return values.map(() => 0);

	const total = values.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return values.map(() => 0);

	const rawColumns = values.map((value) => (value / total) * columns);
	const allocatedColumns = rawColumns.map(Math.floor);
	let remainingColumns = columns - allocatedColumns.reduce((sum, value) => sum + value, 0);
	const largestRemainders = rawColumns
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((left, right) => right.remainder - left.remainder);

	for (let index = 0; index < largestRemainders.length && remainingColumns > 0; index++, remainingColumns--) {
		const slot = largestRemainders[index];
		if (slot) allocatedColumns[slot.index] = (allocatedColumns[slot.index] ?? 0) + 1;
	}

	return allocatedColumns;
}

export function scaleContextSegmentsToUsage(segments: ContextSegments, usedTokens: number): ContextSegments {
	const total = segmentTotal(segments);
	if (usedTokens <= 0) return emptyContextSegments();
	if (total <= 0) {
		return {
			...emptyContextSegments(),
			prompt: Math.round(usedTokens),
		};
	}

	const values = CONTEXT_SEGMENTS.map((segment) => segments[segment.key]);
	const allocated = allocateProportionally(values, Math.round(usedTokens));
	const scaled = emptyContextSegments();
	for (const [index, segment] of CONTEXT_SEGMENTS.entries()) {
		scaled[segment.key] = allocated[index] ?? 0;
	}
	return scaled;
}

export function scaleContextSlicesToUsage(
	slices: readonly ContextSlice[],
	usedTokens: number,
): readonly ContextSlice[] {
	if (usedTokens <= 0) return [];
	const total = slices.reduce((sum, slice) => sum + slice.tokens, 0);
	if (total <= 0) return [{ key: "prompt", tokens: Math.round(usedTokens) }];

	const allocated = allocateProportionally(
		slices.map((slice) => slice.tokens),
		Math.round(usedTokens),
	);
	const scaled: ContextSlice[] = [];
	for (const [index, slice] of slices.entries()) {
		addContextSlice(scaled, slice.key, allocated[index] ?? 0);
	}
	return scaled;
}

function allocateUsedBarColumns(values: readonly number[], width: number): number[] {
	const visibleUsedSegments = values.map((value, index) => ({ value, index })).filter(({ value }) => value > 0);

	if (visibleUsedSegments.length === 0 || visibleUsedSegments.length >= width) {
		return allocateProportionally(values, width);
	}

	const minimumColumns = Array.from({ length: values.length }, () => 0);
	for (const { index } of visibleUsedSegments) {
		minimumColumns[index] = 1;
	}

	const remainingColumns = allocateProportionally(values, width - visibleUsedSegments.length);
	return minimumColumns.map((minimum, index) => minimum + (remainingColumns[index] ?? 0));
}

function allocateBarColumns(values: readonly number[], width: number, usedSegmentCount: number): number[] {
	const usedValues = values.slice(0, usedSegmentCount);
	const freeValues = values.slice(usedSegmentCount);
	const usedTotal = usedValues.reduce((sum, value) => sum + value, 0);
	const freeTotal = freeValues.reduce((sum, value) => sum + value, 0);
	const [usedWidth = 0, freeWidth = 0] = allocateProportionally([usedTotal, freeTotal], width);

	return [...allocateUsedBarColumns(usedValues, usedWidth), ...allocateProportionally(freeValues, freeWidth)];
}

function contextSegmentColor(key: ContextSegmentKey): string {
	return CONTEXT_SEGMENTS.find((segment) => segment.key === key)?.color ?? "muted";
}

function hexToRgb(hex: string): [number, number, number] | undefined {
	const match = hex.match(/^#([0-9a-fA-F]{6})$/);
	if (!match) return undefined;
	const value = Number.parseInt(match[1] ?? "", 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbFg([red, green, blue]: [number, number, number], text: string): string {
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function ansi256ToRgb(index: number): [number, number, number] | undefined {
	if (index < 0 || index > 255) return undefined;
	const basic: [number, number, number][] = [
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
	if (index < 16) return basic[index];
	if (index < 232) {
		const cubeIndex = index - 16;
		const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		return [channel(Math.floor(cubeIndex / 36)), channel(Math.floor((cubeIndex % 36) / 6)), channel(cubeIndex % 6)];
	}
	const gray = 8 + (index - 232) * 10;
	return [gray, gray, gray];
}

function basicAnsiToRgb(code: number): [number, number, number] | undefined {
	const normal: Record<number, [number, number, number]> = {
		30: [0, 0, 0],
		31: [128, 0, 0],
		32: [0, 128, 0],
		33: [128, 128, 0],
		34: [0, 0, 128],
		35: [128, 0, 128],
		36: [0, 128, 128],
		37: [192, 192, 192],
		90: [128, 128, 128],
		91: [255, 0, 0],
		92: [0, 255, 0],
		93: [255, 255, 0],
		94: [0, 0, 255],
		95: [255, 0, 255],
		96: [0, 255, 255],
		97: [255, 255, 255],
	};
	return normal[code];
}

function darkenRgb([red, green, blue]: [number, number, number]): [number, number, number] {
	const factor = 0.68;
	return [Math.round(red * factor), Math.round(green * factor), Math.round(blue * factor)];
}

function themeFgAnsi(theme: Theme, color: ThemeColor): string | undefined {
	const withGetter = theme as Theme & { getFgAnsi?: (color: ThemeColor) => string };
	if (withGetter.getFgAnsi) return withGetter.getFgAnsi(color);

	const sample = theme.fg(color, "x");
	const marker = sample.indexOf("x");
	return marker >= 0 ? sample.slice(0, marker) : undefined;
}

function colorFg(theme: Theme, color: string, text: string): string {
	const rgb = hexToRgb(color);
	if (rgb) return rgbFg(rgb, text);
	return theme.fg(color as ThemeColor, text);
}

function colorFgAnsi(theme: Theme, color: string): string | undefined {
	const rgb = hexToRgb(color);
	if (rgb) {
		const [red, green, blue] = rgb;
		return `\x1b[38;2;${red};${green};${blue}m`;
	}
	return themeFgAnsi(theme, color as ThemeColor);
}

function darkenFgAnsi(ansi: string | undefined): string | undefined {
	if (!ansi) return undefined;
	const truecolor = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	const color256 = ansi.match(/\x1b\[38;5;(\d+)m/);
	const basic = ansi.match(/\x1b\[(\d+)m/);
	const rgb = truecolor
		? ([Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])] as [number, number, number])
		: color256
			? ansi256ToRgb(Number(color256[1]))
			: basic
				? basicAnsiToRgb(Number(basic[1]))
				: undefined;
	if (!rgb) return undefined;

	const [red, green, blue] = darkenRgb(rgb);
	return `\x1b[38;2;${red};${green};${blue}m`;
}

function dimColorFg(theme: Theme, color: string, text: string): string {
	const darkAnsi = darkenFgAnsi(colorFgAnsi(theme, color));
	return darkAnsi ? `${darkAnsi}${text}\x1b[39m` : colorFg(theme, color, text);
}

function renderContextSliceSegment(
	state: FooterRenderState,
	theme: Theme,
	slice: ContextSlice,
	index: number,
	width: number,
	pulsingEnabled = true,
): string {
	if (width <= 0) return "";

	const color = contextSegmentColor(slice.key);
	const text = CONTEXT_BAR_USED.repeat(width);
	const pulsing = pulsingEnabled && state.contextPulseSliceIndexes.includes(index);
	if (pulsing && state.contextPulseFrame % 2 === 1) {
		return colorFg(theme, color, text);
	}
	return dimColorFg(theme, color, text);
}

function contextSlicesForState(state: FooterRenderState): readonly ContextSlice[] {
	return state.contextSlices.length > 0
		? state.contextSlices
		: CONTEXT_SEGMENTS.map((segment) => ({ key: segment.key, tokens: state.contextSegments[segment.key] })).filter(
				(slice) => slice.tokens > 0,
			);
}

function aggregateSlicesBySegment(slices: readonly ContextSlice[]): ContextSegments {
	const segments = emptyContextSegments();
	for (const slice of slices) {
		segments[slice.key] += slice.tokens;
	}
	return segments;
}

function slicesFromSegments(segments: ContextSegments): readonly ContextSlice[] {
	return CONTEXT_SEGMENTS.map((segment) => ({ key: segment.key, tokens: segments[segment.key] })).filter(
		(slice) => slice.tokens > 0,
	);
}

function compactDenseContextSlices(state: FooterRenderState, slices: readonly ContextSlice[]): readonly ContextSlice[] {
	const usedTokens = slices.reduce((sum, slice) => sum + slice.tokens, 0);
	const sourceSegments =
		segmentTotal(state.contextSegments) > 0 ? state.contextSegments : aggregateSlicesBySegment(slices);
	return slicesFromSegments(scaleContextSegmentsToUsage(sourceSegments, usedTokens));
}

function selectContextBarSlices(
	state: FooterRenderState,
	width: number,
): { slices: readonly ContextSlice[]; pulsingEnabled: boolean } {
	const slices = contextSlicesForState(state);
	const freeTokens = Math.max(0, state.contextTotal - state.contextUsed);
	const usedTokens = slices.reduce((sum, slice) => sum + slice.tokens, 0);
	const [usedWidth = 0] = allocateProportionally([usedTokens, freeTokens], width);
	const visibleSliceCount = slices.filter((slice) => slice.tokens > 0).length;
	if (usedWidth > 0 && visibleSliceCount > usedWidth) {
		return { slices: compactDenseContextSlices(state, slices), pulsingEnabled: false };
	}
	return { slices, pulsingEnabled: true };
}

function renderSegmentedContextBar(state: FooterRenderState, theme: Theme, width: number): string {
	const { slices, pulsingEnabled } = selectContextBarSlices(state, width);
	const values = [...slices.map((slice) => slice.tokens), Math.max(0, state.contextTotal - state.contextUsed)];
	const columns = allocateBarColumns(values, width, slices.length);
	const usedSegments = slices
		.map((slice, index) => renderContextSliceSegment(state, theme, slice, index, columns[index] ?? 0, pulsingEnabled))
		.join("");
	const freeWidth = columns[slices.length] ?? 0;
	return usedSegments + theme.fg("dim", CONTEXT_BAR_FREE.repeat(freeWidth));
}

function renderContextBar(state: FooterRenderState, theme: Theme, width: number, suffix: string): string | undefined {
	const safeWidth = Math.max(1, width);
	const legend = CONTEXT_SEGMENTS.map((segment) => colorFg(theme, segment.color, segment.legend)).join(" ");
	const prefix = `${theme.fg("dim", "ctx [")}${legend}${theme.fg("dim", "] ")}`;
	const barWidth = safeWidth - visibleWidth(prefix) - visibleWidth(suffix);
	if (barWidth < MIN_CONTEXT_BAR_WIDTH) return undefined;
	return prefix + renderSegmentedContextBar(state, theme, barWidth) + suffix;
}

function contextHealthColor(state: FooterRenderState): ThemeColor {
	const percent =
		state.contextPercent === null && state.contextTotal > 0
			? (Math.max(0, state.contextUsed) / state.contextTotal) * 100
			: (state.contextPercent ?? 0);
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	if (percent >= 50) return "accent";
	return "success";
}

function renderContextBarVariants(state: FooterRenderState, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (state.contextTotal <= 0) return [truncateToWidth(theme.fg("dim", "ctx no model"), safeWidth, "")];
	const usedTokens = Math.max(0, state.contextUsed);
	const percent =
		state.contextPercent === null && state.contextTotal > 0
			? (usedTokens / state.contextTotal) * 100
			: state.contextPercent;
	const prefix = state.contextUsageEstimated ? "~" : "";
	const percentText = percent === null ? "?" : `${prefix}${percent.toFixed(1)}%`;
	const totalText = `${prefix}${formatTokenCount(usedTokens)}/${formatTokenCount(state.contextTotal)}`;
	const statusColor = contextHealthColor(state);
	return [` ${theme.fg(statusColor, `${percentText} ${totalText}`)}`, ` ${theme.fg(statusColor, percentText)}`, ""]
		.map((suffix) => renderContextBar(state, theme, safeWidth, suffix))
		.filter((line): line is string => line !== undefined);
}

function wrapFooterSegments(segments: string[], width: number, sep: string): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	let current = "";

	for (const segment of segments.filter(Boolean)) {
		const fitted = truncateToWidth(segment, safeWidth);
		if (!current) {
			current = fitted;
			continue;
		}
		const candidate = current + sep + fitted;
		if (visibleWidth(candidate) <= safeWidth) {
			current = candidate;
			continue;
		}
		lines.push(truncateToWidth(current, safeWidth));
		current = fitted;
	}

	if (current) lines.push(truncateToWidth(current, safeWidth));
	return lines;
}

function appendContextGauge(
	lines: string[],
	state: FooterRenderState,
	theme: Theme,
	width: number,
	sep: string,
	options: { reserveRightWidth?: number; singleLine?: boolean; allowFallback?: boolean } = {},
): string[] {
	const safeWidth = Math.max(1, width);
	const nextLines = [...lines];
	const rightReserve = Math.max(0, options.reserveRightWidth ?? 0);
	const lastIdx = nextLines.length - 1;
	const lastLine = nextLines[lastIdx] ?? "";
	const sepWidth = lastLine ? visibleWidth(sep) : 0;
	const sameLineWidth = safeWidth - visibleWidth(lastLine) - sepWidth - rightReserve;
	const sameLineGauge = renderContextBarVariants(state, theme, sameLineWidth)[0];

	if (sameLineGauge) {
		const prefix = lastLine ? lastLine + sep : "";
		if (lastIdx >= 0) nextLines[lastIdx] = prefix + sameLineGauge;
		else nextLines.push(sameLineGauge);
		return nextLines;
	}

	if (options.singleLine) return nextLines;

	const ownLineWidth = safeWidth - rightReserve;
	const ownLineGauge =
		renderContextBarVariants(state, theme, ownLineWidth)[0] ??
		(options.allowFallback === false ? undefined : truncateToWidth(theme.fg("dim", "ctx"), ownLineWidth, ""));
	if (!ownLineGauge) return nextLines;
	nextLines.push(ownLineGauge);
	return nextLines;
}

function getRuntimeColorToken(runtime: RuntimeInfo | undefined): ThemeColor {
	switch (runtime?.name) {
		case "nodejs":
			return "success";
		case "deno":
			return "syntaxType";
		case "bun":
		case "python":
		case "java":
			return "warning";
		case "rust":
		case "ruby":
			return "error";
		case "golang":
			return "syntaxType";
		case "lua":
		case "php":
			return "accent";
		default:
			return "text";
	}
}

function renderRuntimeSegment(theme: Theme, runtime: RuntimeInfo | undefined): string {
	if (!runtime) return "";
	const label = runtime.version ? `${runtime.symbol} ${runtime.version}` : runtime.symbol;
	return theme.fg(getRuntimeColorToken(runtime), label);
}

function renderBranchSegment(theme: Theme, state: FooterRenderState, config: PolishedTuiConfig): string {
	const branch = state.branch;
	if (!branch) return "";

	const branchColor = state.dirty ? "warning" : "success";
	let str = theme.fg(branchColor, branch);
	if (state.dirty) str += theme.fg("warning", " *");
	if (state.ahead) str += theme.fg("success", ` ${config.icons.ahead}${state.ahead}`);
	if (state.behind) str += theme.fg("error", ` ${config.icons.behind}${state.behind}`);
	return str;
}

export function renderEditorTopStatus(
	state: FooterRenderState,
	config: PolishedTuiConfig,
	cwd: string,
	theme: Theme,
	width: number,
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const sep = ` ${dim(">")} `;
	const cwdLabel = theme.fg("accent", formatCwdLabel(cwd, config.icons.cwd));
	const branchLabel = renderBranchSegment(theme, state, config);
	const runtimeLabel = renderRuntimeSegment(theme, state.runtime);
	const modelLabel = theme.fg("muted", state.modelLabel);
	const thinkingLabel =
		state.thinkingLevel && state.thinkingLevel !== "off" ? theme.fg("accent", state.thinkingLevel) : "";

	const safeWidth = Math.max(1, width);
	const fitted = fitFooterSegment(
		Math.max(1, safeWidth - 1),
		[
			[cwdLabel, branchLabel, runtimeLabel, modelLabel, thinkingLabel].filter(Boolean).join(sep),
			[cwdLabel, branchLabel, modelLabel, thinkingLabel].filter(Boolean).join(sep),
			[branchLabel, modelLabel, thinkingLabel].filter(Boolean).join(sep),
			[modelLabel, thinkingLabel].filter(Boolean).join(sep),
			modelLabel,
		].filter(Boolean),
	);
	return safeWidth > 1 ? `${fitted} ` : fitted;
}

export function renderEditorContextStatus(state: FooterRenderState, theme: Theme, width: number): string {
	const safeWidth = Math.max(1, width);
	if (state.contextTotal <= 0) return truncateToWidth(theme.fg("dim", "ctx no model"), safeWidth, "");

	const usedTokens = Math.max(0, state.contextUsed);
	const percent =
		state.contextPercent === null && state.contextTotal > 0
			? (usedTokens / state.contextTotal) * 100
			: state.contextPercent;
	const prefix = state.contextUsageEstimated ? "~" : "";
	const percentText = percent === null ? "?" : `${prefix}${percent.toFixed(1)}%`;
	const totalText = `${prefix}${formatTokenCount(usedTokens)}/${formatTokenCount(state.contextTotal)}`;
	const statusColor = contextHealthColor(state);
	const metricParts = [
		theme.fg(statusColor, `${percentText} ${totalText}`),
		state.hasTokens ? theme.fg("muted", state.tokenLabel) : "",
		state.hasCost ? theme.fg("success", state.costLabel) : "",
	].filter(Boolean);
	const suffix = ` ${metricParts.join(" ")}`;

	return (
		renderContextBar(state, theme, safeWidth, suffix) ??
		renderContextBar(state, theme, safeWidth, ` ${theme.fg(statusColor, percentText)}`) ??
		truncateToWidth(theme.fg("dim", "ctx"), safeWidth, "")
	);
}

export function renderFooter(
	state: FooterRenderState,
	config: PolishedTuiConfig,
	cwd: string,
	theme: Theme,
	width: number,
	options: { minimal?: boolean } = {},
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const sep = ` ${dim(">")} `;

	const cwdLabel = theme.fg("accent", formatCwdLabel(cwd, config.icons.cwd));
	const branchLabel = renderBranchSegment(theme, state, config);
	const runtimeLabel = renderRuntimeSegment(theme, state.runtime);

	const locationVariants: string[] = [];
	if (cwdLabel && branchLabel && runtimeLabel) {
		locationVariants.push([cwdLabel, branchLabel, runtimeLabel].join(sep));
	}
	if (cwdLabel && branchLabel) locationVariants.push([cwdLabel, branchLabel].join(sep));
	if (cwdLabel) locationVariants.push(cwdLabel);
	if (branchLabel) locationVariants.push(branchLabel);
	const locationBlock = locationVariants.length > 0 ? fitFooterSegment(width, locationVariants) : "";

	const plainModelStr = theme.fg("muted", state.modelLabel);
	const modelStr =
		state.thinkingLevel && state.thinkingLevel !== "off"
			? plainModelStr + sep + theme.fg("accent", state.thinkingLevel)
			: plainModelStr;
	const modelBlock = fitFooterSegment(width, modelStr === plainModelStr ? [plainModelStr] : [modelStr, plainModelStr]);

	const rightParts: string[] = [];
	if (state.hasTokens) rightParts.push(theme.fg("muted", state.tokenLabel));
	if (state.hasCost) rightParts.push(theme.fg("success", state.costLabel));
	const rightBlock = rightParts.join(" ");
	const rightWidth = visibleWidth(rightBlock);

	if (options.minimal) {
		const minimalLines = appendContextGauge([modelBlock], state, theme, width, sep, { singleLine: true });
		const minimal = minimalLines[0] ?? modelBlock;
		return [truncateToWidth(minimal, width)];
	}

	let lines = wrapFooterSegments([locationBlock, modelBlock], width, sep);

	if (rightBlock) {
		const withRightReserve = appendContextGauge(lines, state, theme, width, sep, {
			reserveRightWidth: rightWidth + 1,
			allowFallback: false,
		});
		const ctxLine = withRightReserve[withRightReserve.length - 1] ?? "";
		if (withRightReserve.join("\n") !== lines.join("\n") && visibleWidth(ctxLine) + 1 + rightWidth <= width) {
			lines = withRightReserve;
		} else {
			lines = appendContextGauge(lines, state, theme, width, sep);
		}
	} else {
		lines = appendContextGauge(lines, state, theme, width, sep);
	}

	if (rightBlock) {
		const lastIdx = lines.length - 1;
		const lastLine = lines[lastIdx] ?? "";
		const lastWidth = visibleWidth(lastLine);

		if (lines.length > 0 && lastWidth + 1 + rightWidth <= width) {
			lines[lastIdx] = lastLine + " ".repeat(width - lastWidth - rightWidth) + rightBlock;
		} else {
			lines.push(" ".repeat(Math.max(0, width - rightWidth)) + rightBlock);
		}
	}

	if (state.usageLines?.length) {
		lines.push(...state.usageLines);
	} else {
		lines.push(truncateToWidth(theme.fg("accent", state.providerLabel), width));
	}

	return lines.map((line) => truncateToWidth(line, width));
}
