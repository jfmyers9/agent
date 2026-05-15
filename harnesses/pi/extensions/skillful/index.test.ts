import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider, EditorComponent } from "@earendil-works/pi-tui";
import { findMentionAtCursor, wrapProvider } from "./autocomplete";
import { installEditorHighlight } from "./editor";
import { colorize } from "./highlight";
import extension from "./index";
import {
	buildItems,
	loadedDetails,
	reconstructLoadedSkills,
	rewriteSlashSkillReferences,
	SKILLFUL_CUSTOM_TYPE,
	stripFrontmatter,
} from "./skills";

describe("skillful highlighting", () => {
	test("highlights known dollar and slash skill references", () => {
		const skills = new Set(["tdd", "crit"]);
		expect(colorize("use $tdd then /skill:crit not $missing", skills)).toBe(
			"use \x1b[36m$tdd\x1b[39m then \x1b[36m/skill:crit\x1b[39m not $missing",
		);
	});

	test("preserves ansi escapes around plain text segments", () => {
		const skills = new Set(["tdd"]);
		expect(colorize("\x1b[7muse $tdd\x1b[0m", skills)).toBe("\x1b[7muse \x1b[36m$tdd\x1b[39m\x1b[0m");
	});
});

describe("skillful autocomplete", () => {
	test("detects dollar mention at cursor", () => {
		expect(findMentionAtCursor("please $td", 10)).toEqual({ token: "$td", query: "td" });
		expect(findMentionAtCursor("email$a", 7)).toBeNull();
	});

	test("returns skill suggestions and applies completion", async () => {
		const base: AutocompleteProvider = {
			async getSuggestions() {
				return { items: [{ value: "base", label: "base" }], prefix: "" };
			},
			applyCompletion(lines) {
				return { lines, cursorLine: 0, cursorCol: 0 };
			},
		};
		const wrapped = wrapProvider(base, () => buildItems(new Map([["tdd", "/skills/tdd/SKILL.md"]])));
		const suggestions = await wrapped.getSuggestions(["use $td"], 0, 7, {});
		expect(suggestions?.prefix).toBe("$td");
		expect(suggestions?.items[0]?.value).toBe("$tdd");
		expect(
			wrapped.applyCompletion(["use $td"], 0, 7, suggestions?.items[0] ?? { value: "$tdd", label: "$tdd" }, "$td"),
		).toEqual({
			lines: ["use $tdd"],
			cursorLine: 0,
			cursorCol: 8,
		});
	});
});

describe("skillful editor wrapping", () => {
	test("wraps the existing editor line transform", () => {
		const editor: EditorComponent & { transformEditorLine?: (line: string) => string } = {
			render: () => [],
			invalidate() {},
			transformEditorLine: (line) => `before ${line}`,
		};
		let factory: ((...args: never[]) => EditorComponent) | undefined = () => editor;
		installEditorHighlight(
			{
				getEditorComponent: () => factory as never,
				setEditorComponent: (next) => {
					factory = next as never;
				},
			},
			() => new Set(["tdd"]),
		);

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never) as typeof editor;
		expect(nextEditor.transformEditorLine?.("$tdd")).toBe("before \x1b[36m$tdd\x1b[39m");
	});

	test("wraps editor render output when line transform is unavailable", () => {
		const editor: EditorComponent = {
			render: () => ["use $tdd"],
			invalidate() {},
			getText: () => "",
			setText() {},
			handleInput() {},
		};
		let factory: ((...args: never[]) => EditorComponent) | undefined = () => editor;
		installEditorHighlight(
			{
				getEditorComponent: () => factory as never,
				setEditorComponent: (next) => {
					factory = next as never;
				},
			},
			() => new Set(["tdd"]),
		);

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never);
		expect(nextEditor?.render(80)).toEqual(["use \x1b[36m$tdd\x1b[39m"]);
	});

	test("wraps editors installed after highlight setup", () => {
		let factory: ((...args: never[]) => EditorComponent) | undefined;
		const ui = {
			getEditorComponent: () => factory,
			setEditorComponent: (next: typeof factory) => {
				factory = next;
			},
		};
		installEditorHighlight(ui, () => new Set(["tdd"]));

		const editor: EditorComponent = {
			render: () => ["use $tdd"],
			invalidate() {},
			getText: () => "",
			setText() {},
			handleInput() {},
		};
		ui.setEditorComponent(() => editor);

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never);
		expect(nextEditor?.render(80)).toEqual(["use \x1b[36m$tdd\x1b[39m"]);
	});
});

describe("skillful skills", () => {
	test("strips yaml frontmatter", () => {
		expect(stripFrontmatter("---\nname: tdd\n---\nbody")).toBe("body");
		expect(stripFrontmatter("body")).toBe("body");
	});

	test("rewrites slash skill references without touching paths", () => {
		const skills = ["implement", "plan"];
		expect(
			rewriteSlashSkillReferences(
				"Use `/implement`, then suggest /plan <research>. Keep ~/blueprints/foo/archive/ unchanged.",
				skills,
			),
		).toBe("Use `$implement`, then suggest $plan <research>. Keep ~/blueprints/foo/archive/ unchanged.");
	});

	test("reconstructs loaded skills from active branch after latest compaction", () => {
		const entries = [
			{
				type: "custom_message",
				customType: SKILLFUL_CUSTOM_TYPE,
				details: loadedDetails("precompact", "read"),
			},
			{ type: "compaction" },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "skill",
					details: loadedDetails("tool-read", "read"),
				},
			},
			{
				type: "custom_message",
				customType: SKILLFUL_CUSTOM_TYPE,
				details: {
					...loadedDetails("custom-read", "read"),
					loads: [loadedDetails("custom-read", "read"), loadedDetails("grouped-read", "read")],
				},
			},
			{
				type: "custom_message",
				customType: SKILLFUL_CUSTOM_TYPE,
				details: loadedDetails("cached-only", "cached"),
			},
		];

		expect([...reconstructLoadedSkills(entries)].sort()).toEqual(["custom-read", "grouped-read", "tool-read"]);
	});
});

describe("skillful extension", () => {
	test("does not visually rewrite leading dollar shorthand", async () => {
		const handlers = new Map<string, Array<(event: { text: string }) => unknown>>();
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: "/skills/tdd/SKILL.md" } },
				{ source: "skill", name: "skill:crit", sourceInfo: { path: "/skills/crit/SKILL.md" } },
			],
			on: (event: string, handler: (event: { text: string }) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		expect(handlers.has("input")).toBe(false);
	});

	test("loads referenced dollar skills as custom messages before agent start", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-"));
		const skillPath = join(dir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: tdd\n---\n# TDD\n\nUse `/plan` after the test loop.\n");

		const handlers = new Map<
			string,
			Array<(event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown>
		>();
		const emitted: Array<{ channel: string; data: unknown }> = [];
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: skillPath } },
				{ source: "skill", name: "skill:plan", sourceInfo: { path: "/skills/plan/SKILL.md" } },
			],
			on: (event: string, handler: (event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: {
				emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
			},
		};

		extension(pi as never);

		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				prompt: "$tdd $tdd\n\nfix this",
				systemPrompt: "base",
			},
			{ sessionManager: { getBranch: () => [] } },
		);
		expect(result).toEqual({
			message: {
				customType: "skillful-load",
				display: true,
				content: `<skill name="tdd" location="${skillPath}">\nReferences are relative to ${dir}.\n\n# TDD\n\nUse \`$plan\` after the test loop.\n\n</skill>`,
				details: {
					extension: "skillful",
					kind: "skill-load",
					name: "tdd",
					status: "read",
					filePath: skillPath,
					baseDir: dir,
				},
			},
		});
		expect(emitted).toEqual([{ channel: "skillful:cache", data: { names: ["tdd"] } }]);
	});

	test("loads multiple referenced dollar skills in one custom message", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-"));
		const tddPath = join(dir, "tdd.md");
		const planPath = join(dir, "plan.md");
		writeFileSync(tddPath, "---\nname: tdd\n---\n# TDD\n");
		writeFileSync(planPath, "---\nname: plan\n---\n# Plan\n");

		const handlers = new Map<
			string,
			Array<(event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown>
		>();
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: tddPath } },
				{ source: "skill", name: "skill:plan", sourceInfo: { path: planPath } },
			],
			on: (event: string, handler: (event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				prompt: "$tdd then $plan",
				systemPrompt: "base",
			},
			{ sessionManager: { getBranch: () => [] } },
		);

		const message = (result as { message?: { content?: string; details?: { loads?: unknown[] } } } | undefined)
			?.message;
		expect(message?.content).toContain('<skill name="tdd"');
		expect(message?.content).toContain('<skill name="plan"');
		expect(message?.details?.loads).toHaveLength(2);
	});

	test("returns visible custom message for unknown dollar skill references", async () => {
		const handlers = new Map<
			string,
			Array<(event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown>
		>();
		const pi = {
			getCommands: () => [],
			on: (event: string, handler: (event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				prompt: "$missing fix this",
				systemPrompt: "base",
			},
			{ sessionManager: { getBranch: () => [] } },
		);
		expect(result).toEqual({
			message: {
				customType: SKILLFUL_CUSTOM_TYPE,
				content: "Unknown skill: $missing",
				display: true,
			},
		});
	});

	test("registers skill tool with read and cached results", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-"));
		const skillPath = join(dir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: tdd\n---\n# TDD\n\nUse `/plan` after the test loop.\n");

		const tools: Array<{
			name: string;
			renderCall?: (
				args: { name: string },
				theme: typeof theme,
				context: { isPartial?: boolean },
			) => {
				render: (width: number) => string[];
			};
			renderResult?: (
				result: { details?: unknown; content: unknown[] },
				options: unknown,
				theme: typeof theme,
			) => {
				render: (width: number) => string[];
			};
			execute: (
				id: string,
				params: { name: string },
				signal?: AbortSignal,
				onUpdate?: unknown,
				ctx?: unknown,
			) => Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: unknown;
			}>;
		}> = [];
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: skillPath } },
				{ source: "skill", name: "skill:plan", sourceInfo: { path: "/skills/plan/SKILL.md" } },
			],
			on() {},
			registerTool: (tool: never) => tools.push(tool),
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const tool = tools.find((candidate) => candidate.name === "skill");
		expect(tool).toBeTruthy();
		const ctx = { sessionManager: { getBranch: () => [] } };
		const first = await tool?.execute("call-1", { name: "tdd" }, undefined, undefined, ctx);
		expect(first?.content[0]?.text).toContain("# TDD");
		expect(first?.content[0]?.text).toContain("Use `$plan` after the test loop.");
		expect(first?.details).toMatchObject({ extension: "skillful", kind: "skill-load", name: "tdd", status: "read" });

		const second = await tool?.execute("call-2", { name: "tdd" }, undefined, undefined, ctx);
		expect(second?.content[0]?.text).toBe(
			'Skill "tdd" is already loaded in this session branch. Continue following its instructions.',
		);
		expect(second?.details).toMatchObject({
			extension: "skillful",
			kind: "skill-load",
			name: "tdd",
			status: "cached",
		});
		await expect(tool?.execute("call-3", { name: "missing" }, undefined, undefined, ctx)).rejects.toThrow(
			'Unknown skill "missing"',
		);

		const theme = {
			fg: (_role: string, text: string) => text,
			bold: (text: string) => text,
		};
		expect(
			tool
				?.renderResult?.({ content: [], details: second?.details }, { expanded: false }, theme)
				?.render(80)[0]
				?.trim(),
		).toBe("Skill - tdd cached");
		expect(tool?.renderCall?.({ name: "tdd" }, theme, { isPartial: false })?.render(80)).toEqual([]);
	});

	test("publishes branch-derived cache on session lifecycle events", async () => {
		const handlers = new Map<string, Array<(event: { reason?: string }, ctx: unknown) => unknown>>();
		const emitted: Array<{ channel: string; data: unknown }> = [];
		const pi = {
			getCommands: () => [],
			on: (event: string, handler: (event: { reason?: string }, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: {
				emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
			},
		};

		extension(pi as never);

		const ctx = {
			hasUI: false,
			sessionManager: {
				getBranch: () => [
					{
						type: "custom_message",
						customType: SKILLFUL_CUSTOM_TYPE,
						details: loadedDetails("question", "read"),
					},
				],
			},
		};
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("session_compact")?.[0]?.({}, { ...ctx, sessionManager: { getBranch: () => [] } });

		expect(emitted).toEqual([
			{ channel: "skillful:cache", data: { names: ["question"] } },
			{ channel: "skillful:cache", data: { names: [] } },
		]);
	});

	test("reinstalls autocomplete provider after reload", async () => {
		const ui = {
			added: 0,
			addAutocompleteProvider() {
				this.added += 1;
			},
		};
		const createPi = () => {
			const handlers = new Map<
				string,
				Array<(event: { reason?: string }, ctx: { hasUI: boolean; ui: typeof ui }) => unknown>
			>();
			return {
				handlers,
				pi: {
					getCommands: () => [],
					on: (
						event: string,
						handler: (event: { reason?: string }, ctx: { hasUI: boolean; ui: typeof ui }) => unknown,
					) => {
						handlers.set(event, [...(handlers.get(event) ?? []), handler]);
					},
					registerTool() {},
					registerMessageRenderer() {},
					events: { emit() {} },
				},
			};
		};

		const first = createPi();
		extension(first.pi as never);
		await first.handlers.get("session_start")?.[0]?.({ reason: "startup" }, { hasUI: true, ui });

		const second = createPi();
		extension(second.pi as never);
		await second.handlers.get("session_start")?.[0]?.({ reason: "reload" }, { hasUI: true, ui });

		expect(ui.added).toBe(2);
	});
});
