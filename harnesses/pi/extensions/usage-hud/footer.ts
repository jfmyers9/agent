// @ts-nocheck
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UsageHudConfig } from "./config";
import type { ContextPressure, HudState } from "./state";

const BAR_FILLED = "━";
const BAR_EMPTY = "─";
const QUOTA_FILLED = "▓";
const QUOTA_EMPTY = "░";
const QUOTA_TICK = "│";

function formatTokenCount(value: number | null): string {
	if (value === null) return "?";
	if (value >= 1_000_000)
		return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
	if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
	if (value >= 1_000)
		return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${value}`;
}

function formatCost(value: number): string {
	if (!value) return "$0";
	return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function pressureColor(
	config: UsageHudConfig,
	pressure: ContextPressure,
): ThemeColor {
	switch (pressure) {
		case "error":
			return config.colors.contextError;
		case "warning":
			return config.colors.contextWarning;
		case "normal":
			return config.colors.contextNormal;
		case "unknown":
			return "dim";
	}
}

function renderContextGauge(
	state: HudState,
	config: UsageHudConfig,
	theme: Theme,
	barWidth: number,
	counts: boolean,
) {
	const rawPercent = state.contextPercent;
	const percent =
		rawPercent === null ? 0 : Math.max(0, Math.min(100, rawPercent));
	const filled = Math.round((percent / 100) * barWidth);
	const color = pressureColor(config, state.contextPressure);
	const bar =
		theme.fg(color, BAR_FILLED.repeat(filled)) +
		theme.fg("dim", BAR_EMPTY.repeat(barWidth - filled));
	const percentLabel =
		rawPercent === null ? "?%" : `${Math.round(rawPercent)}%`;
	const countLabel =
		counts && state.contextWindow
			? ` ${formatTokenCount(state.contextUsed)}/${formatTokenCount(state.contextWindow)}`
			: "";
	return `${theme.fg("dim", "ctx ")}${bar} ${theme.fg(color, percentLabel)}${theme.fg("dim", countLabel)}`;
}

function fitSegment(width: number, variants: string[]): string {
	const safeWidth = Math.max(1, width);
	for (const variant of variants) {
		if (visibleWidth(variant) <= safeWidth) return variant;
	}
	return truncateToWidth(variants[variants.length - 1] ?? "", safeWidth);
}

function wrapSegments(
	segments: string[],
	width: number,
	separator: string,
): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	let current = "";

	for (const rawSegment of segments) {
		const segment = truncateToWidth(rawSegment, safeWidth);
		if (!segment) continue;
		if (!current) {
			current = segment;
			continue;
		}
		const candidate = current + separator + segment;
		if (visibleWidth(candidate) <= safeWidth) {
			current = candidate;
		} else {
			lines.push(truncateToWidth(current, safeWidth));
			current = segment;
		}
	}

	if (current) lines.push(truncateToWidth(current, safeWidth));
	return lines.length > 0 ? lines : [""];
}

function terminalRows(): number | undefined {
	const rows = process.stdout.rows;
	return typeof rows === "number" && Number.isFinite(rows) ? rows : undefined;
}

function compactTerminal(config: UsageHudConfig): boolean {
	const rows = terminalRows();
	return rows !== undefined && rows < config.usageHud.compactMinRows;
}

function formatDuration(secs: number): string {
	const value = Math.max(0, Math.floor(secs));
	if (value >= 86_400)
		return `${Math.floor(value / 86_400)}d${Math.floor((value % 86_400) / 3600)}h`;
	if (value >= 3600)
		return `${Math.floor(value / 3600)}h${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}m`;
	return `${Math.floor(value / 60)}m`;
}

function paceBalanceSecs(
	usedPercent: number,
	resetSecs: number,
	windowSecs: number,
): number | null {
	if (windowSecs <= 0 || resetSecs <= 0) return null;
	const elapsedSecs = windowSecs - resetSecs;
	if (elapsedSecs < 60) return null;
	const expectedRemaining = (resetSecs / windowSecs) * 100;
	const actualRemaining = 100 - usedPercent;
	return Math.round(((actualRemaining - expectedRemaining) * windowSecs) / 100);
}

function quotaColor(
	usedPercent: number,
	resetSecs: number,
	windowSecs: number,
): ThemeColor {
	if (windowSecs <= 0 || resetSecs <= 0) {
		if (usedPercent >= 85) return "error";
		if (usedPercent >= 65) return "warning";
		return "accent";
	}
	const elapsedPercent = ((windowSecs - resetSecs) / windowSecs) * 100;
	const deficit = usedPercent - elapsedPercent;
	if (deficit >= 8) return "error";
	if (deficit >= 2) return "warning";
	return "accent";
}

function paceColor(balanceSecs: number | null, windowSecs: number): ThemeColor {
	if (balanceSecs === null || balanceSecs >= 0) return "accent";
	const deficitPercent =
		(Math.abs(balanceSecs) / Math.max(1, windowSecs)) * 100;
	if (deficitPercent >= 15) return "error";
	if (deficitPercent >= 8) return "warning";
	return "warning";
}

function formatPace(balanceSecs: number | null): string {
	if (balanceSecs === null || balanceSecs === 0) return "";
	const sign = balanceSecs > 0 ? "+" : "-";
	return `${sign}${formatDuration(Math.abs(balanceSecs))}`;
}

function renderQuotaBar(
	theme: Theme,
	barWidth: number,
	usedPercent: number,
	resetSecs: number,
	windowSecs: number,
	fillColor: ThemeColor,
): string {
	const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
	const remainingCells = Math.round((remainingPercent / 100) * barWidth);
	const elapsedPercent =
		windowSecs > 0 && resetSecs > 0
			? ((windowSecs - resetSecs) / windowSecs) * 100
			: 0;
	const expectedRemainingPercent = Math.max(
		0,
		Math.min(100, 100 - elapsedPercent),
	);
	const tickCell =
		elapsedPercent > 0
			? Math.max(
					0,
					Math.min(
						barWidth - 1,
						Math.round((expectedRemainingPercent / 100) * barWidth),
					),
				)
			: null;
	const balance = paceBalanceSecs(usedPercent, resetSecs, windowSecs);
	const tickColor = paceColor(balance, windowSecs);
	let out = "";
	for (let i = 0; i < barWidth; i++) {
		const isTick = tickCell === i;
		const filled = i < remainingCells;
		if (isTick) out += theme.fg(tickColor, QUOTA_TICK);
		else if (filled) out += theme.fg(fillColor, QUOTA_FILLED);
		else out += theme.fg("dim", QUOTA_EMPTY);
	}
	return out;
}

function renderQuotaWindow(
	state: HudState,
	theme: Theme,
	barWidth: number,
	window: HudState["quota"]["windows"][number],
	showReset: boolean,
): string {
	const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
	const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
	const color = quotaColor(usedPercent, window.resetSecs, window.windowSecs);
	const bar = renderQuotaBar(
		theme,
		barWidth,
		usedPercent,
		window.resetSecs,
		window.windowSecs,
		color,
	);
	const pace = formatPace(
		paceBalanceSecs(usedPercent, window.resetSecs, window.windowSecs),
	);
	const paceSegment = pace
		? ` ${theme.fg(paceColor(paceBalanceSecs(usedPercent, window.resetSecs, window.windowSecs), window.windowSecs), pace)}`
		: "";
	const resetSegment =
		showReset && window.resetSecs > 0
			? ` ${theme.fg("dim", `↺${formatDuration(window.resetSecs)}`)}`
			: "";
	return `${theme.fg("dim", window.label)} ${bar} ${theme.fg(color, `${Math.round(remainingPercent)}%`)}${paceSegment}${resetSegment}`;
}

function renderQuotaLine(
	state: HudState,
	theme: Theme,
	width: number,
	separator: string,
): string[] {
	if (!state.quota?.windows.length) return [];
	const provider = theme.fg(
		"accent",
		state.quota.provider || state.providerLabel,
	);
	const windows = state.quota.windows.map((window) =>
		fitSegment(width, [
			renderQuotaWindow(state, theme, 10, window, true),
			renderQuotaWindow(state, theme, 8, window, true),
			renderQuotaWindow(state, theme, 8, window, false),
			renderQuotaWindow(state, theme, 6, window, false),
			renderQuotaWindow(state, theme, 4, window, false),
		]),
	);
	return wrapSegments([provider, ...windows], width, separator);
}

export function renderFooter(
	state: HudState,
	config: UsageHudConfig,
	branch: string | null,
	theme: Theme,
	width: number,
): string[] {
	const sep = ` ${theme.fg(config.colors.separator, "›")} `;
	const cwdLabel = theme.fg(
		config.colors.cwdText,
		`${config.icons.cwd} ${formatCwd(state.cwd)}`,
	);
	const branchLabel = branch
		? theme.fg(config.colors.git, `${config.icons.git} ${branch}`)
		: "";
	const location = fitSegment(width, [
		branchLabel ? `${cwdLabel}${sep}${branchLabel}` : cwdLabel,
		branchLabel || cwdLabel,
	]);

	const modelBase = theme.fg("muted", state.modelLabel);
	const provider = theme.fg("dim", state.providerLabel);
	const thinking =
		state.thinkingLevel && state.thinkingLevel !== "off"
			? theme.fg("accent", state.thinkingLevel)
			: "";
	const model = fitSegment(width, [
		thinking
			? `${provider}${sep}${modelBase}${sep}${thinking}`
			: `${provider}${sep}${modelBase}`,
		thinking ? `${modelBase}${sep}${thinking}` : modelBase,
		modelBase,
	]);

	const context = fitSegment(width, [
		renderContextGauge(state, config, theme, 12, true),
		renderContextGauge(state, config, theme, 10, false),
		renderContextGauge(state, config, theme, 8, false),
		renderContextGauge(state, config, theme, 6, false),
	]);

	const inputOutput = theme.fg(
		config.colors.tokens,
		`↑${formatTokenCount(state.inputTokens)} ↓${formatTokenCount(state.outputTokens)}`,
	);
	const cost = theme.fg(config.colors.cost, formatCost(state.cost));
	const usage = state.hasUsage ? `${inputOutput} ${cost}` : "";

	if (compactTerminal(config)) {
		return [
			truncateToWidth(
				wrapSegments([model, context], width, sep)[0] ?? "",
				width,
			),
		];
	}

	const lines = wrapSegments([location, model, context], width, sep);
	if (usage) {
		const lastIndex = lines.length - 1;
		const lastLine = lines[lastIndex] ?? "";
		const gap = width - visibleWidth(lastLine) - visibleWidth(usage);
		if (gap > 1) {
			lines[lastIndex] = `${lastLine}${" ".repeat(gap)}${usage}`;
		} else {
			lines.push(
				`${" ".repeat(Math.max(0, width - visibleWidth(usage)))}${usage}`,
			);
		}
	}

	const quotaLines = renderQuotaLine(state, theme, width, sep);
	if (quotaLines.length > 0) {
		lines.push(...quotaLines);
	}

	if (state.contextPressure === "warning") {
		lines.push(
			truncateToWidth(
				theme.fg(config.colors.contextWarning, "context high — compact soon"),
				width,
			),
		);
	} else if (state.contextPressure === "error") {
		lines.push(
			truncateToWidth(
				theme.fg(config.colors.contextError, "context critical — compact now"),
				width,
			),
		);
	}

	return lines.map((line) => truncateToWidth(line, width));
}
