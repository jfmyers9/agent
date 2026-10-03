import { beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	RAIL_PULSE_MS,
	renderPolishedEditorForTest,
	setEditorChromeProvider,
	setEditorSessionIdentityProvider,
	setWorkingAnimationForTest,
	WORKING_SWEEP_MS,
} from "./editor";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "dim" ? 2 : 37}m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
} as any;
const rgbTheme = {
	fg: (_color: string, text: string) => `\x1b[38;2;100;50;200m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
	getFgAnsi: () => "\x1b[38;2;100;50;200m",
} as any;

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

// Brightness sum for each animated glyph of the "Working" word, in order.
function workingLetterBrightness(row: string): number[] {
	return [...row.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m([Working])/g)].map(
		(match) => Number(match[1]) + Number(match[2]) + Number(match[3]),
	);
}

function editor(overrides: Record<string, unknown> = {}) {
	return {
		transformEditorLine: (line: string) => line,
		...overrides,
	};
}

describe("polished TUI editor", () => {
	beforeEach(() => {
		setWorkingAnimationForTest(false, 0);
		setEditorChromeProvider(undefined);
		setEditorSessionIdentityProvider(undefined);
	});

	test("keeps autocomplete lines after the editor frame", () => {
		const lines = renderPolishedEditorForTest(
			editor({
				isShowingAutocomplete: () => true,
				autocompleteList: { render: () => ["$question"] },
			}),
			50,
			() => ["> $q", "", "$question"],
			28,
			theme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toBe("$question");
	});

	test("renders animated working text on the first editor row", () => {
		setWorkingAnimationForTest(true, 0);

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("Working… (0s)");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("formats working durations with hours", () => {
		setWorkingAnimationForTest(true, 0, Date.now() - 3_665_000);

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			48,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("Working… (1h 1m 5s)");
	});

	test("renders session identity before animated working text", () => {
		setWorkingAnimationForTest(true, 0);
		setEditorSessionIdentityProvider(() => ({ name: "Spawn mosaic refactor" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			48,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("Spawn mosaic refactor · Working… (0s)");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});

	test("ignores stale session identity providers during render", () => {
		setEditorSessionIdentityProvider(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).not.toContain("This extension ctx is stale");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("truncates long session identity before working status", () => {
		setWorkingAnimationForTest(true, 0, Date.now() - 65_000);
		setEditorSessionIdentityProvider(() => ({ name: "A very long named session that should shrink first" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			34,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("… · Working… (1m 5s)");
		expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
	});

	test("renders mosaic label and secondary rail color", () => {
		setEditorSessionIdentityProvider(() => ({ label: "A2", name: "Tests", color: "74c7ec" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "normal" }),
			32,
			() => ["> hello", ""],
			28,
			theme,
		);

		expect(stripAnsi(lines[0] ?? "")).toStartWith("▐▌ A2 Tests");
		expect(lines[0]).toContain("\x1b[38;2;116;199;236m▐");
		expect(lines[0]).toContain("\x1b[38;2;72;123;146mA2 Tests");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	test("right-aligns editor chrome status on the first row", () => {
		setEditorChromeProvider(() => ({ topRight: "status" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "normal" }),
			40,
			() => ["> hello", ""],
			28,
			theme,
		);

		expect(stripAnsi(lines[0] ?? "")).toEndWith("status");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("pulses the rail background on a slow cosine while working", () => {
		const rowAt = (elapsedMs: number) => {
			setWorkingAnimationForTest(true, elapsedMs);
			return (
				renderPolishedEditorForTest(editor({ getMode: () => "insert" }), 40, () => ["> hello", ""], 28, rgbTheme)[0] ??
				""
			);
		};
		const dark = rowAt(0);
		const bright = rowAt(RAIL_PULSE_MS / 2);
		expect(dark).toContain("\x1b[48;2;70;35;140m");
		expect(bright).toContain("\x1b[48;2;105;53;210m");
		expect(dark).not.toBe(bright);
	});

	test("drives the working shine from elapsed time, not from tick count", () => {
		const rowAt = (elapsedMs: number) => {
			setWorkingAnimationForTest(true, elapsedMs);
			return renderPolishedEditorForTest(editor(), 40, () => ["> hi", ""], 28, rgbTheme)[0] ?? "";
		};
		expect(rowAt(0)).toBe(rowAt(0));
		expect(rowAt(WORKING_SWEEP_MS)).not.toBe(rowAt(0));
		expect(workingLetterBrightness(rowAt(WORKING_SWEEP_MS * 2)).join()).toBe(workingLetterBrightness(rowAt(0)).join());
	});

	test("keeps the working shine interpolated and always lit", () => {
		const baseBrightness = 75 + 38 + 150;
		const profiles = new Set<string>();
		for (let elapsedMs = 0; elapsedMs <= WORKING_SWEEP_MS * 2; elapsedMs += 25) {
			setWorkingAnimationForTest(true, elapsedMs);
			const row = renderPolishedEditorForTest(editor(), 40, () => ["> hi", ""], 28, rgbTheme)[0] ?? "";
			const brightness = workingLetterBrightness(row);
			expect(brightness).toHaveLength(7);
			// Never a fully dim frame: one glyph stays brighter than the base color.
			expect(Math.max(...brightness)).toBeGreaterThan(baseBrightness);
			// Interpolated band, not a hard one-glyph step.
			expect(new Set(brightness).size).toBeGreaterThan(1);
			profiles.add(brightness.join(","));
		}
		expect(profiles.size).toBeGreaterThan(10);
	});
});
