import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig, type PolishedTuiConfig } from "./config";
import { emptyFooterState, type FooterRenderState, renderFooter, renderUsageBar } from "./footer";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const COLOR_CODES: Record<string, number> = {
	accent: 35,
	borderAccent: 96,
	dim: 2,
	error: 31,
	success: 32,
	thinkingXhigh: 95,
	warning: 33,
};

const theme = {
	fg: (color: string, text: string) => `\x1b[${COLOR_CODES[color] ?? 37}m${text}\x1b[39m`,
} as any;

const config: PolishedTuiConfig = {
	...defaultConfig,
	icons: {
		...defaultConfig.icons,
		cwd: "",
	},
};

function state(overrides: Partial<FooterRenderState> = {}): FooterRenderState {
	return {
		...emptyFooterState(),
		modelLabel: "m",
		providerLabel: "OpenAI",
		contextPercent: 33,
		contextUsed: 33_000,
		contextTotal: 100_000,
		contextSegments: {
			system: 3000,
			prompt: 10_000,
			assistant: 15_000,
			thinking: 1000,
			tools: 4000,
		},
		contextSlices: [
			{ key: "system", tokens: 3000 },
			{ key: "prompt", tokens: 10_000 },
			{ key: "assistant", tokens: 15_000 },
			{ key: "thinking", tokens: 1000 },
			{ key: "tools", tokens: 4000 },
		],
		...overrides,
	};
}

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

describe("renderFooter", () => {
	test("expands the context gauge into slack before right-side metrics", () => {
		const lines = renderFooter(
			state({
				hasTokens: true,
				tokenLabel: "↑100 ↓50",
				hasCost: true,
				costLabel: "$0.01",
			}),
			config,
			"/tmp/p",
			theme,
			80,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).includes("↑100 ↓50 $0.01")) ?? "";
		const plain = stripAnsi(ctxLine);

		expect(visibleWidth(ctxLine)).toBe(80);
		expect(plain).toContain("ctx [s p a r x] ");
		expect(plain).toContain("━");
		expect(plain).toContain("─");
		expect(plain).toContain("33.0%");
		expect(plain).not.toContain("█");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("moves the context gauge to its own full-width row when the existing row is crowded", () => {
		const lines = renderFooter(
			state({
				modelLabel: "very-long-model-label",
			}),
			config,
			"/tmp/a/very/long/project/path",
			theme,
			30,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).startsWith("ctx [s p a r x] ")) ?? "";
		const plain = stripAnsi(ctxLine);

		expect(visibleWidth(ctxLine)).toBe(30);
		expect(plain).toContain("━");
		expect(plain).toContain("─");
		expect(plain).not.toContain("very-long-model-label");
		expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
	});

	test("renders used context colors in context order", () => {
		const lines = renderFooter(
			state({
				contextSegments: {
					system: 0,
					prompt: 10_000,
					assistant: 15_000,
					thinking: 0,
					tools: 4000,
				},
				contextSlices: [
					{ key: "prompt", tokens: 10_000 },
					{ key: "tools", tokens: 4000 },
					{ key: "assistant", tokens: 15_000 },
				],
			}),
			config,
			"/tmp/p",
			theme,
			80,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).includes("ctx [s p a r x] ")) ?? "";
		const promptIndex = ctxLine.indexOf("\x1b[38;2;165;95;114m━");
		const toolsIndex = ctxLine.indexOf("\x1b[38;2;169;154;119m━");
		const assistantIndex = ctxLine.indexOf("\x1b[38;2;93;150;160m━");

		expect(promptIndex).toBeGreaterThanOrEqual(0);
		expect(toolsIndex).toBeGreaterThan(promptIndex);
		expect(assistantIndex).toBeGreaterThan(toolsIndex);
	});

	test("keeps the visual context bar proportional when many slices are visible", () => {
		const keys = ["prompt", "assistant", "tools", "thinking"] as const;
		const contextSlices = Array.from({ length: 80 }, (_, index) => ({
			key: keys[index % keys.length],
			tokens: 1012.5,
		}));
		const lines = renderFooter(
			state({
				contextPercent: 29.6,
				contextUsed: 81_000,
				contextTotal: 272_000,
				contextSlices,
			}),
			config,
			"/tmp/p",
			theme,
			160,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).includes("29.6% 81k/272k")) ?? "";
		const plain = stripAnsi(ctxLine);
		const usedColumns = [...plain].filter((char) => char === "━").length;
		const freeColumns = [...plain].filter((char) => char === "─").length;
		const visualPercent = (usedColumns / (usedColumns + freeColumns)) * 100;

		expect(visualPercent).toBeGreaterThanOrEqual(28);
		expect(visualPercent).toBeLessThanOrEqual(32);
	});

	test("keeps non-prompt segment colors visible when dense slices are compacted", () => {
		const contextSlices = [
			...Array.from({ length: 50 }, () => ({ key: "prompt" as const, tokens: 1000 })),
			...Array.from({ length: 10 }, () => ({ key: "assistant" as const, tokens: 1000 })),
			...Array.from({ length: 10 }, () => ({ key: "thinking" as const, tokens: 1000 })),
			...Array.from({ length: 10 }, () => ({ key: "tools" as const, tokens: 1000 })),
		];
		const lines = renderFooter(
			state({
				contextPercent: 29.6,
				contextUsed: 81_000,
				contextTotal: 272_000,
				contextSegments: {
					system: 0,
					prompt: 51_000,
					assistant: 10_000,
					thinking: 10_000,
					tools: 10_000,
				},
				contextSlices,
			}),
			config,
			"/tmp/p",
			theme,
			160,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).includes("29.6% 81k/272k")) ?? "";

		expect(ctxLine).toContain("\x1b[38;2;165;95;114m━");
		expect(ctxLine).toContain("\x1b[38;2;93;150;160m━");
		expect(ctxLine).toContain("\x1b[38;2;138;113;168m━");
		expect(ctxLine).toContain("\x1b[38;2;169;154;119m━");
	});

	test("renders the context legend with matching colors", () => {
		const lines = renderFooter(state(), config, "/tmp/p", theme, 80);
		const ctxLine = lines.find((line) => stripAnsi(line).includes("ctx [s p a r x] ")) ?? "";

		expect(ctxLine).toContain("ctx [");
		expect(ctxLine).toContain("\x1b[38;2;166;227;161ms\x1b[39m");
		expect(ctxLine).toContain("\x1b[38;2;243;139;168mp\x1b[39m");
		expect(ctxLine).toContain("\x1b[38;2;137;220;235ma\x1b[39m");
		expect(ctxLine).toContain("\x1b[38;2;203;166;247mr\x1b[39m");
		expect(ctxLine).toContain("\x1b[38;2;249;226;175mx\x1b[39m");
	});

	test("colors the context usage suffix by context health", () => {
		const lines = renderFooter(
			state({
				contextPercent: 70.6,
				contextUsed: 192_000,
				contextTotal: 272_000,
			}),
			config,
			"/tmp/p",
			theme,
			80,
		);
		const ctxLine = lines.find((line) => stripAnsi(line).includes("70.6% 192k/272k")) ?? "";

		expect(ctxLine).toContain("\x1b[33m70.6% 192k/272k\x1b[39m");
	});

	test("pulses the latest live context slice by color only", () => {
		const lines = renderFooter(
			state({
				contextPulseSliceIndexes: [1, 2],
				contextPulseFrame: 1,
			}),
			config,
			"/tmp/p",
			theme,
			80,
		);
		const ctxLine = lines.find((line) => stripAnsi(line).includes("ctx [s p a r x] ")) ?? "";
		const plain = stripAnsi(ctxLine);

		expect(plain).toContain("━");
		expect(plain).not.toContain("█");
		expect(ctxLine).toContain("\x1b[38;2;243;139;168m");
		expect(ctxLine).toContain("\x1b[38;2;137;220;235m");
		expect(ctxLine).not.toContain("\x1b[1m");
	});
});

describe("renderUsageBar", () => {
	const window = (usedPercent: number, resetSecs = 3600, label = "Week") => ({
		label,
		usedPercent,
		resetSecs,
		windowSecs: 604800,
	});

	test("uses the context rail glyphs with a colored percentage and muted reset countdown", () => {
		const line = renderUsageBar("OpenAI", [window(37)], theme, 56);
		expect(visibleWidth(line)).toBe(56);
		expect(stripAnsi(line)).toMatch(/^OpenAI Week ━+─+ 37% ↻ 1h$/);
		expect(line).toContain("\x1b[32m37%\x1b[39m");
		expect(line).toContain("\x1b[2m ↻ 1h\x1b[39m");
		expect(stripAnsi(line)).not.toMatch(/[#[\]]/);
	});

	test("shares context-health colors as quota consumption rises", () => {
		for (const [percent, code] of [
			[0, 32],
			[49, 32],
			[50, 35],
			[69, 35],
			[70, 33],
			[89, 33],
			[90, 31],
			[100, 31],
		]) {
			const line = renderUsageBar("OpenAI", [window(percent)], theme, 56);
			expect(line).toContain(`\x1b[${code}m${percent}%\x1b[39m`);
			if (percent > 0) expect(line).toContain(`\x1b[${code}m━`);
			if (percent < 100) expect(line).toContain("\x1b[2m─");
			if (percent === 0) expect(stripAnsi(line)).not.toContain("━");
			if (percent === 100) expect(stripAnsi(line)).not.toContain("─");
		}
	});

	test("keeps showing the most consumed quota window", () => {
		const line = stripAnsi(renderUsageBar("OpenAI", [window(20, 3600, "5h"), window(82)], theme, 56));
		expect(line).toContain("OpenAI Week");
		expect(line).toContain("82%");
		expect(line).not.toContain("5h");
	});

	test("fits colored output at every width and preserves the percentage before labels", () => {
		for (const provider of ["OpenAI", "A very long provider label", "模型"]) {
			for (let width = 0; width <= 80; width++) {
				const line = renderUsageBar(provider, [window(37)], theme, width);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (width >= 3) expect(stripAnsi(line)).toContain("37%");
				if (width >= 18) expect(stripAnsi(line)).toContain("↻ 1h");
			}
		}
	});

	test("formats reset intervals and clamps quota percentages", () => {
		for (const [seconds, label] of [
			[0, "now"],
			[1, "1m"],
			[3599, "60m"],
			[3600, "1h"],
			[86400, "1d"],
		] as const) {
			expect(stripAnsi(renderUsageBar("OpenAI", [window(37, seconds)], theme, 56))).toContain(`↻ ${label}`);
		}
		expect(stripAnsi(renderUsageBar("OpenAI", [window(120)], theme, 56))).toContain("100%");
		expect(stripAnsi(renderUsageBar("OpenAI", [window(-10)], theme, 56))).toContain("0%");
	});

	test("omits the bar when quota data or terminal space is absent", () => {
		expect(renderUsageBar("OpenAI", [], theme, 56)).toBe("");
		expect(renderUsageBar("OpenAI", [window(37)], theme, 0)).toBe("");
	});
});
