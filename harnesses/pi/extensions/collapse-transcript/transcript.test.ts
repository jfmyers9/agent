import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
	AssistantMessageComponent,
	initTheme,
	type SessionEntry,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, ProcessTerminal, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, sharedMotionScheduler, tuiTheme } from "@luan.sh/pi-libtui";
import type { TuiMouseEvent } from "@luan.sh/pi-libtui/mouse";
import { mountTranscriptProjection, ToolActivity, type TranscriptEntry } from "@luan.sh/pi-libtui/tool";
import {
	getThemeByName,
	theme,
} from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ActivityTimings } from "./activity-timing.ts";
import { ActivityTranscript, activitySummary } from "./activity-transcript.ts";

initTheme("dark", false);
afterEach(() => {
	configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
	mock.restore();
});

class TestTui extends TuiAltScreen {
	requestRender(): void {}
}

function message(content: Parameters<AssistantMessageComponent["updateContent"]>[0]["content"]) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-responses" as const,
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: 0,
	};
}

function fixture(timings = new ActivityTimings(), now: () => number = () => 0, activeTheme = theme) {
	configureTuiAppearance({ activityIndicator: "static", textEffect: "off" });
	const tui = new TestTui(new ProcessTerminal());
	const document = new Container();
	const chat = new Container();
	document.addChild(new Container());
	document.addChild(new Container());
	document.addChild(chat);
	tui.addChild(document);
	let projection: ActivityTranscript | undefined;
	const unmount = mountTranscriptProjection(tui, (entries) => {
		projection = new ActivityTranscript(entries, activeTheme, () => {}, timings, now);
		return projection;
	});
	if (!unmount || !projection) throw new Error("Expected a mounted transcript");
	return { tui, document, chat, projection, unmount };
}

function lines(component: { render(width: number): string[] }, width = 80): string[] {
	return component.render(width).map((line) => Bun.stripANSI(line).trimEnd());
}
function click(projection: ActivityTranscript, row: number): void {
	const event: TuiMouseEvent = {
		type: "press",
		row,
		col: 2,
		screenRow: row,
		screenCol: 2,
		button: 0,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(projection.onMouse(event)).toBe(true);
	expect(projection.onMouse({ ...event, type: "release" })).toBe(true);
}

test("native thinking and tool rows collapse together and expand with their original content", () => {
	const f = fixture();
	const thought = new AssistantMessageComponent(
		message([{ type: "thinking", thinking: "**Inspect source**\n\nDetailed reasoning." }]),
	);
	const tool = new ToolExecutionComponent(
		"exec_command",
		"one",
		{ cmd: "cat file" },
		undefined,
		undefined,
		f.tui,
		"/tmp",
	);
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "original output" }], isError: false });
	f.chat.addChild(thought);
	f.chat.addChild(tool);
	const compact = lines(f.document);
	expect(compact.filter(Boolean)).toHaveLength(1);
	expect(compact.join("\n")).toContain("Inspect source");
	expect(compact.join("\n")).toContain("2 steps");
	expect(compact.join("\n")).not.toContain("Detailed reasoning.");
	expect(compact.join("\n")).not.toContain("original output");
	click(f.projection, 1);
	const expanded = lines(f.document).join("\n");
	expect(expanded).toContain("Detailed reasoning.");
	expect(expanded).toContain("original output");
	click(f.projection, 1);
	expect(lines(f.document).filter(Boolean)).toHaveLength(1);
	f.unmount();
	expect(f.document.children[2]).toBe(f.chat);
	expect(lines(f.document).join("\n")).toContain("original output");
});

test("the active turn stays visible across completed tools, prose, and continuations until settlement", () => {
	const f = fixture();
	f.chat.addChild(
		new AssistantMessageComponent(
			message([{ type: "thinking", thinking: "**Previous turn**\n\nHistorical details." }]),
		),
	);
	f.chat.addChild(new Text("Next user request", 0, 0));
	f.projection.beginTurn();
	const thought = new AssistantMessageComponent();
	const source = message([{ type: "thinking", thinking: "**Current work**\n\nLive reasoning." }]);
	thought.updateContent(source, true);
	f.chat.addChild(thought);
	let rendered = lines(f.document).join("\n");
	expect(rendered).toContain("Live reasoning.");
	expect(rendered).not.toContain("Historical details.");
	thought.updateContent(source, false);
	const tool = new ToolExecutionComponent("read", "live", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "Live tool progress" }], isError: false }, true);
	f.chat.addChild(tool);
	expect(lines(f.document).join("\n")).toContain("Live tool progress");
	tool.updateResult({ content: [{ type: "text", text: "Completed tool output" }], isError: false });
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Checking the result." }])));
	// Automatic continuation must not mark the earlier steps as historical.
	f.projection.beginTurn();
	f.chat.addChild(
		new AssistantMessageComponent(message([{ type: "thinking", thinking: "**Verify result**\n\nFollow-up detail." }])),
	);
	rendered = lines(f.document).join("\n");
	expect(rendered).toContain("Live reasoning.");
	expect(rendered).toContain("Completed tool output");
	expect(rendered).toContain("Follow-up detail.");
	expect(rendered).toContain("Checking the result.");
	f.projection.finishTurn();
	rendered = lines(f.document).join("\n");
	expect(rendered).not.toContain("Live reasoning.");
	expect(rendered).not.toContain("Completed tool output");
	expect(rendered).not.toContain("Follow-up detail.");
	expect(rendered).toContain("Current work · 2 steps");
	expect(rendered).toContain("Verify result · 1 step");
	expect(rendered).toContain("Checking the result.");
	// Starting another turn leaves the finished folds alone.
	f.projection.beginTurn();
	expect(lines(f.document).join("\n")).toBe(rendered);
	f.unmount();
});

test("streamed updates retain expansion and update the latest thinking heading", () => {
	const f = fixture();
	const thought = new AssistantMessageComponent();
	const source = message([{ type: "thinking", thinking: "**First step**\n\nDetails." }]);
	thought.updateContent(source, true);
	f.chat.addChild(thought);
	expect(lines(f.document).join("\n")).toContain("First step");
	click(f.projection, 1);
	// Pi may reuse the same streamed message object.
	source.content = [{ type: "thinking", thinking: "**Second step**\n\nMore detail." }];
	thought.updateContent(source, true);
	const updated = lines(f.document).join("\n");
	expect(updated).toContain("Second step");
	expect(updated).toContain("More detail.");
	thought.updateContent(source, false);
	expect(lines(f.document).join("\n")).not.toContain("●");
	f.unmount();
});

test("tools retain the latest thinking summary while running and after completion", () => {
	const f = fixture();
	const thought = new AssistantMessageComponent(
		message([{ type: "thinking", thinking: "**First step**\n\nDetails.\n\n**Implement marker helper**\n\nNext." }]),
	);
	f.chat.addChild(thought);
	const tool = new ToolExecutionComponent("exec", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	f.chat.addChild(tool);
	const running = lines(f.document).join("\n");
	expect(running).toContain("Implement marker helper");
	expect(running).toContain("2 steps");
	expect(running).not.toContain("exec");
	tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	expect(lines(f.document).join("\n")).toContain("Implement marker helper");
	const next = new AssistantMessageComponent();
	next.updateContent(message([{ type: "thinking", thinking: "**Verify marker rendering**" }]), true);
	f.chat.addChild(next);
	expect(lines(f.document).join("\n")).toContain("Verify marker rendering");
	f.unmount();
});

test("tool summaries use live semantic fields without flattening or pre-truncating custom renderers", () => {
	const f = fixture();
	let headerRenders = 0;
	let payloadRenders = 0;
	const detail = `${"long/path/".repeat(12)}transcript.ts`;
	const activity = new ToolActivity({
		theme,
		requestRender: () => {},
		action: {
			render: () => {
				headerRenders++;
				return ["Explored", "  └ Read truncated…"];
			},
			invalidate() {},
		},
		view: {
			action: { verb: "Read", detail, status: "succeeded" },
			payload: {
				kind: "component",
				preview: {
					render: () => {
						payloadRenders++;
						return ["original tool output"];
					},
					invalidate() {},
				},
			},
		},
	});
	const tool = new ToolExecutionComponent(
		"exec",
		"one",
		{},
		undefined,
		{ renderResult: () => activity },
		f.tui,
		"/tmp",
	);
	tool.updateResult({ content: [], isError: false });
	f.chat.addChild(tool);
	const compact = lines(f.document, 200).join("\n");
	expect(compact).toContain(`Read · ${detail}`);
	expect(compact).not.toMatch(/[└…]/u);
	expect(headerRenders).toBe(0);
	expect(payloadRenders).toBe(0);
	// Nested renderers can update independently of the enclosing Pi result.
	activity.update({ action: { verb: "Verified", detail: "transcript.ts", status: "succeeded" } });
	expect(lines(f.document).join("\n")).toContain("Verified · transcript.ts");
	click(f.projection, 1);
	expect(lines(f.document).join("\n")).toContain("Explored");
	expect(headerRenders).toBeGreaterThan(0);
	f.unmount();
	activity.dispose();
});

test("open folds refresh native expansion without new results or summaries", () => {
	const f = fixture();
	let payloadRenders = 0;
	const tool = new ToolExecutionComponent(
		"codemode",
		"expansion",
		{},
		undefined,
		{
			renderResult: (_result, options) => ({
				getActivityLabel: () => "Read sample.ts",
				render: () => {
					payloadRenders++;
					return [options.expanded ? "JavaScript and Argument previews" : "Compact output"];
				},
				invalidate() {},
			}),
		},
		f.tui,
		"/tmp",
	);
	tool.updateResult({ content: [], isError: false });
	f.chat.addChild(tool);
	lines(f.document);
	click(f.projection, 1);
	expect(lines(f.document).join("\n")).toContain("Compact output");
	tool.setExpanded(true);
	expect(lines(f.document).join("\n")).toContain("JavaScript and Argument previews");
	tool.setExpanded(false);
	const collapsed = lines(f.document).join("\n");
	expect(collapsed).toContain("Compact output");
	expect(collapsed).not.toContain("Argument previews");
	const renders = payloadRenders;
	expect(lines(f.document).join("\n")).toBe(collapsed);
	expect(payloadRenders).toBe(renders);
	f.unmount();
});

test("prose stays visible and separates folds; failure counts survive collapse", () => {
	const f = fixture();
	f.chat.addChild(
		new AssistantMessageComponent(
			message([
				{ type: "thinking", thinking: "**Check files**\n\nLonger thought." },
				{ type: "text", text: "Here is my answer." },
			]),
		),
	);
	const tool = new ToolExecutionComponent("build", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.updateResult({ content: [{ type: "text", text: "build failure details" }], isError: true });
	f.chat.addChild(tool);
	const compact = lines(f.document).join("\n");
	expect(compact).toContain("Here is my answer.");
	expect(compact).toContain("Check files");
	expect(compact).toContain("1 failed");
	expect(compact).not.toContain("Longer thought.");
	expect(compact).not.toContain("build failure details");
	f.unmount();
});

test("retains unknown nodes and native error notices; detach stops animation without owning native tools", () => {
	const mounts = sharedMotionScheduler.activeMountCount;
	const f = fixture();
	f.chat.addChild(new Text("unknown notice", 0, 0));
	const failed = new AssistantMessageComponent({
		...message([{ type: "thinking", thinking: "Interrupted thought" }]),
		stopReason: "error",
		errorMessage: "network failed",
	});
	f.chat.addChild(failed);
	const tool = new ToolExecutionComponent("build", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	f.chat.addChild(tool);
	const rendered = lines(f.document).join("\n");
	expect(rendered).toContain("unknown notice");
	expect(rendered).toContain("network failed");
	f.unmount();
	expect(sharedMotionScheduler.activeMountCount).toBe(mounts);
	expect(f.chat.children).toContain(tool);
});

test("unsupported roots and duplicate mounts leave the host unchanged", () => {
	const tui = new TestTui(new ProcessTerminal());
	expect(
		mountTranscriptProjection(tui, () => {
			throw new Error("must not run");
		}),
	).toBeUndefined();
	const f = fixture();
	expect(
		mountTranscriptProjection(f.tui, () => {
			throw new Error("must not run");
		}),
	).toBeUndefined();
	f.unmount();
	const release = mountTranscriptProjection(f.tui, (entries) => new ActivityTranscript(entries, theme, () => {}));
	expect(release).toBeDefined();
	release?.();
});

test("summary uses the latest supplied heading, bounds text and strips control sequences", () => {
	const part: TranscriptEntry = {
		kind: "thinking",
		key: {},
		component: new Container(),
		running: false,
		failed: false,
		summary: "**Old**\n\nPrior.\n\n**Latest**\n\nCurrent.",
	};
	expect(activitySummary(part)).toBe("Latest");
	const text = activitySummary({ ...part, summary: `\x1b]52;c;secret\x07${"word ".repeat(1000)}` });
	expect(text).not.toContain("\x1b");
	expect(text.length).toBeLessThanOrEqual(241);
	const transcript = new ActivityTranscript(
		() => [part],
		theme,
		() => {},
	);
	for (const width of [1, 2, 8, 40])
		expect(transcript.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
	transcript.dispose();
});

test("muted, underlined rows retain saved wall time across parallel tools and reloads", () => {
	// Chalk disables attributes without a TTY; exercise the terminal theme contract.
	const styledTheme = getThemeByName("dark")!;
	spyOn(styledTheme, "underline").mockImplementation((text) => `\x1b[4m${text}\x1b[24m`);
	spyOn(styledTheme, "italic").mockImplementation((text) => `\x1b[3m${text}\x1b[23m`);
	const source = {
		...message([
			{ type: "thinking", thinking: "**Checking index baseline**" },
			{ type: "toolCall", id: "one", name: "read", arguments: {} },
			{ type: "toolCall", id: "two", name: "read", arguments: {} },
		]),
		timestamp: 1_000,
	};
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: new Date(3_000).toISOString(),
			message: source,
		},
	];
	const result = (id: string, timestamp: number): SessionEntry => ({
		type: "message",
		id,
		parentId: "assistant",
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp },
	});
	const timings = new ActivityTimings();
	timings.load(branch);
	let now = 11_000;
	const f = fixture(timings, () => now, styledTheme);
	f.chat.addChild(new AssistantMessageComponent(source));
	for (const id of ["one", "two"]) {
		const tool = new ToolExecutionComponent("read", id, {}, undefined, undefined, f.tui, "/tmp");
		tool.markExecutionStarted();
		f.chat.addChild(tool);
	}
	expect(lines(f.document).join("\n")).toContain("Working for 10s · Checking index baseline · 3 steps");
	now = 66_000;
	expect(lines(f.document).join("\n")).toContain("Working for 1m 5s · Checking index baseline · 3 steps");
	f.unmount();
	branch.push(result("one", 101_000), result("two", 417_000));
	// Rebuilding native components must use saved timestamps, not their mount time.
	timings.load(branch);
	const reloaded = fixture(timings, () => 999_000, styledTheme);
	reloaded.chat.addChild(new AssistantMessageComponent(source));
	for (const id of ["one", "two"]) {
		const tool = new ToolExecutionComponent("read", id, {}, undefined, undefined, reloaded.tui, "/tmp");
		tool.updateResult({ content: [], isError: false });
		reloaded.chat.addChild(tool);
	}
	const rows = reloaded.document.render(100);
	const row = rows.find((line) => Bun.stripANSI(line).includes("Worked for"))!;
	expect(Bun.stripANSI(row)).toStartWith("  Worked for 6m 56s · Checking index baseline · 3 steps");
	expect(row).toStartWith(tuiTheme(styledTheme).fgAnsi("text.muted"));
	expect(row).toContain(styledTheme.italic("Checking index baseline"));
	expect(row).toContain("\x1b[4:4m");
	expect(visibleWidth(row)).toBe(100);
	const padding = " ".repeat(100 - visibleWidth(Bun.stripANSI(row).trimEnd()));
	expect(padding.length).toBeGreaterThan(20);
	expect(row).toContain(tuiTheme(styledTheme).fg("text.muted", padding));
	expect(row).toContain(`${padding}\x1b[39m\x1b[24m`);
	expect(row).not.toContain("\x1b[1m");
	expect(Bun.stripANSI(row)).not.toMatch(/[•●]/u);
	for (const width of [1, 2, 8, 40])
		expect(reloaded.document.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	reloaded.unmount();
	timings.load([]);
	expect(
		timings.elapsed(
			[
				{
					kind: "thinking",
					key: {},
					component: new Container(),
					summary: "Old",
					timestamp: 1_000,
					running: false,
					failed: false,
				},
			],
			999_000,
		),
	).toBeUndefined();
});

test("regular mode passes native rows through unchanged and returns to fullscreen folds", () => {
	const f = fixture();
	const source = message([{ type: "thinking", thinking: "**Summary**\n\nOriginal hidden detail." }]);
	const thought = new AssistantMessageComponent(source);
	f.chat.addChild(thought);
	const saved = structuredClone(source);
	Object.defineProperty(f.tui, "mode", { value: "regular", configurable: true });
	expect(lines(f.document)).toEqual(lines(f.chat));
	expect(lines(f.document).join("\n")).toContain("Original hidden detail.");
	Object.defineProperty(f.tui, "mode", { value: "fullscreen", configurable: true });
	expect(lines(f.document).join("\n")).not.toContain("Original hidden detail.");
	expect(source).toEqual(saved);
	f.unmount();
});

test("extension lifecycle preserves active work across delayed mounts, remounts, and settlement", async () => {
	const { default: extension } = await import("./index.ts");
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	let factory: any;
	let branchReads = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		sessionManager: {
			getLeafId: () => "leaf",
			getBranch: () => {
				branchReads++;
				return [];
			},
		},
		ui: {
			setWidget: (_key: string, value: unknown) => {
				factory = value;
			},
		},
	};
	extension({ on: (name: string, fn: any) => handlers.set(name, fn) } as any);
	handlers.get("session_start")!({}, ctx);
	// A run can start before Pi invokes the widget factory.
	handlers.get("agent_start")!({}, ctx);
	const f = fixture();
	f.unmount();
	f.chat.addChild(
		new AssistantMessageComponent(message([{ type: "thinking", thinking: "**Working**\n\nKeep me visible." }])),
	);
	const first = factory(f.tui, theme);
	expect(lines(f.document).join("\n")).toContain("Keep me visible.");
	const second = factory(f.tui, theme);
	first.dispose(); // Old widget cleanup must not detach the new projection.
	expect(f.document.children[2]).not.toBe(f.chat);
	expect(lines(f.document).join("\n")).toContain("Keep me visible.");
	handlers.get("agent_start")!({}, ctx);
	expect(lines(f.document).join("\n")).toContain("Keep me visible.");
	handlers.get("agent_settled")!({}, ctx);
	expect(lines(f.document).join("\n")).not.toContain("Keep me visible.");
	expect(branchReads).toBe(2);
	handlers.get("session_shutdown")!({}, ctx);
	expect(f.document.children[2]).toBe(f.chat);
	expect(factory).toBeUndefined();
	second.dispose();
	expect(f.document.children[2]).toBe(f.chat);
});

test("starting the extension midrun fails visible until settled; noninteractive sessions never mount", async () => {
	const { default: extension } = await import("./index.ts");
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	let factory: any;
	const ctx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => false,
		sessionManager: { getLeafId: () => null, getBranch: () => [] },
		ui: {
			setWidget: (_key: string, value: unknown) => {
				factory = value;
			},
		},
	};
	extension({ on: (name: string, fn: any) => handlers.set(name, fn) } as any);
	handlers.get("session_start")!({}, { ...ctx, mode: "rpc" });
	expect(factory).toBeUndefined();
	handlers.get("session_start")!({}, { ...ctx, hasUI: false });
	expect(factory).toBeUndefined();
	handlers.get("session_start")!({}, ctx);
	const f = fixture();
	f.unmount();
	f.chat.addChild(
		new AssistantMessageComponent(message([{ type: "thinking", thinking: "**Working**\n\nExisting run detail." }])),
	);
	const widget = factory(f.tui, theme);
	expect(lines(f.document).join("\n")).toContain("Existing run detail.");
	handlers.get("agent_settled")!({}, ctx);
	expect(lines(f.document).join("\n")).not.toContain("Existing run detail.");
	widget.dispose();
	widget.dispose();
	expect(f.document.children[2]).toBe(f.chat);
});

test("Pi document mouse routing opens folds and native compact tool-search previews", async () => {
	const { createToolSearchExtension, DefaultResourceLoader, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const { installNativeToolBridge } = await import("../runtime-support/native-tool-bridge.ts");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = await mkdtemp(join(tmpdir(), "pi-folded-native-"));
	const release = installNativeToolBridge();
	const f = fixture();
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: SettingsManager.inMemory(),
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			extensionFactories: [createToolSearchExtension()],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const definition = loader
			.getExtensions()
			.extensions.flatMap((ext) => [...ext.tools.values()])
			.find((tool) => tool.definition.name === "tool_search")!.definition;
		const tool = new ToolExecutionComponent("tool_search", "search", { query: "files" }, {}, definition, f.tui, root);
		tool.updateResult({
			content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `result ${i}`).join("\n") }],
			isError: false,
		});
		f.chat.addChild(tool);
		const nativeClick = (row: number) => {
			const base = {
				button: "left" as const,
				x: 2,
				y: row,
				screenX: 2,
				screenY: row,
				width: 80,
				height: 100,
				shift: false,
				alt: false,
				ctrl: false,
			};
			f.document.handleMouse({ ...base, type: "press" });
			f.document.handleMouse({ ...base, type: "release" });
			f.document.handleMouse({ ...base, type: "click" });
		};
		expect(lines(f.document).join("\n")).not.toContain("result 0");
		nativeClick(1);
		const opened = lines(f.document);
		expect(opened.join("\n")).toContain("result 0");
		expect(opened.join("\n")).not.toContain("result 14");
		const previewRow = opened.findIndex((row) => row.includes("result 0"));
		expect(previewRow).toBeGreaterThan(1);
		nativeClick(previewRow);
		expect(lines(f.document).join("\n")).toContain("result 14");
		nativeClick(1);
		expect(lines(f.document).join("\n")).not.toContain("result 0");
		// A fresh active turn also routes native clicks outside any fold.
		f.projection.beginTurn();
		const live = new ToolExecutionComponent("tool_search", "live", { query: "files" }, {}, definition, f.tui, root);
		live.updateResult({
			content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `live ${i}`).join("\n") }],
			isError: false,
		});
		f.chat.addChild(live);
		const current = lines(f.document);
		nativeClick(current.findIndex((row) => row.includes("live 0")));
		expect(lines(f.document).join("\n")).toContain("live 14");
	} finally {
		f.unmount();
		release();
		await rm(root, { recursive: true, force: true });
	}
});
