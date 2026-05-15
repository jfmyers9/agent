import { beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderPolishedEditorForTest,
	setCachedSkillNamesForTest,
	setEditorChromeProvider,
	setEditorSessionIdentityProvider,
	setWorkingAnimationForTest,
} from "./editor";
import extension from "./index";

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

function editor(overrides: Record<string, unknown> = {}) {
	return {
		transformEditorLine: (line: string) => line,
		...overrides,
	};
}

describe("polished TUI editor cached skills", () => {
	beforeEach(() => {
		setWorkingAnimationForTest(false, 0);
		setEditorChromeProvider(undefined);
		setEditorSessionIdentityProvider(undefined);
	});

	test("renders no cached skills metadata when cache is empty", () => {
		setCachedSkillNamesForTest([]);
		const lines = renderPolishedEditorForTest(editor(), 40, () => ["> hello", ""], 28, theme);

		expect(stripAnsi(lines.at(-1) ?? "")).not.toContain("skills:");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("renders cached skills on the bottom editor row", () => {
		setCachedSkillNamesForTest(["question", "research"]);
		const lines = renderPolishedEditorForTest(editor(), 50, () => ["> hello", ""], 28, theme);

		expect(stripAnsi(lines.at(-1) ?? "")).toContain("skills: question, research");
		expect(lines.every((line) => visibleWidth(line) <= 50)).toBe(true);
	});

	test("truncates long cached skills metadata width-safely", () => {
		setCachedSkillNamesForTest(["question", "research", "structure", "implement"]);
		const lines = renderPolishedEditorForTest(editor(), 24, () => ["> hello", ""], 28, theme);
		const bottom = lines.at(-1) ?? "";

		expect(stripAnsi(bottom)).toContain("skills:");
		expect(stripAnsi(bottom)).toContain("…");
		expect(visibleWidth(bottom)).toBeLessThanOrEqual(24);
	});

	test("keeps autocomplete lines after the editor frame", () => {
		setCachedSkillNamesForTest(["question"]);
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

		expect(stripAnsi(lines.at(-2) ?? "")).toContain("skills: question");
		expect(stripAnsi(lines.at(-1) ?? "")).toBe("$question");
	});

	test("extension updates cached skills from skillful cache events and clears on shutdown", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const eventHandlers = new Map<string, (data: unknown) => void>();
		const pi = {
			getThinkingLevel: () => "medium",
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			events: {
				on: (channel: string, handler: (data: unknown) => void) => {
					eventHandlers.set(channel, handler);
					return () => eventHandlers.delete(channel);
				},
			},
			registerCommand: () => {},
		};

		extension(pi as never);
		eventHandlers.get("skillful:cache")?.({ names: ["research"] });
		expect(
			stripAnsi(renderPolishedEditorForTest(editor(), 50, () => ["> hello", ""], 28, theme).at(-1) ?? ""),
		).toContain("skills: research");

		await handlers.get("session_shutdown")?.[0]?.({}, {});
		expect(
			stripAnsi(renderPolishedEditorForTest(editor(), 50, () => ["> hello", ""], 28, theme).at(-1) ?? ""),
		).not.toContain("skills:");
		expect(eventHandlers.has("skillful:cache")).toBe(false);
	});

	test("renders animated working text on the first editor row", () => {
		setCachedSkillNamesForTest([]);
		setWorkingAnimationForTest(true, 3);

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("Working…");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("renders session identity before animated working text", () => {
		setCachedSkillNamesForTest([]);
		setWorkingAnimationForTest(true, 3);
		setEditorSessionIdentityProvider(() => ({ name: "Spawn mosaic refactor" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			48,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("Spawn mosaic refactor · Working…");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});

	test("ignores stale session identity providers during render", () => {
		setCachedSkillNamesForTest([]);
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
		setCachedSkillNamesForTest([]);
		setWorkingAnimationForTest(true, 3);
		setEditorSessionIdentityProvider(() => ({ name: "A very long named session that should shrink first" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			34,
			() => ["> hello", ""],
			28,
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("… · Working…");
		expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
	});

	test("renders mosaic label and secondary rail color", () => {
		setCachedSkillNamesForTest([]);
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
		setCachedSkillNamesForTest([]);
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

	test("pulses the rail background from the mode color while working", () => {
		setCachedSkillNamesForTest([]);
		setWorkingAnimationForTest(true, 0);
		const dark = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			28,
			rgbTheme,
		)[0];

		setWorkingAnimationForTest(true, 13);
		const bright = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			28,
			rgbTheme,
		)[0];

		expect(dark).toContain("\x1b[48;2;18;9;36m");
		expect(bright).toContain("\x1b[48;2;121;60;241m");
		expect(dark).not.toBe(bright);
	});
});
