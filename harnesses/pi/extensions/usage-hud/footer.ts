import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UsageHudConfig } from "./config";
import type { ContextPressure, HudState } from "./state";

const BAR_FILLED = "━";
const BAR_EMPTY = "─";

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
