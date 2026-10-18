import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as terminal from "../shared/terminal";
import { type AgentCostSnapshot, installCoordinatorLookup } from "../subagents/runtime";
import * as config from "./config";
import * as cursor from "./cursor-focus";
import * as editor from "./editor";
import { emptyFooterState, renderEditorContextStatus } from "./footer";
import * as git from "./git";
import extension from "./index";
import * as runtime from "./runtime";
import * as usage from "./usage";

const theme = { fg: (_role: string, text: string) => text } as any;
type Handler = (...args: any[]) => any;
type Timer = { callback: () => void; interval: number; unref: ReturnType<typeof mock> };

// Mock only external UI/config/process effects. Accounting, coordinator lookup,
// event handlers and the context-status renderer run their production code.
describe("TUI cost integration", () => {
	let handlers: Map<string, Handler>;
	let commands: Map<string, { handler: Handler }>;
	let timers: Set<Timer>;
	let chrome: Handler | undefined;
	let children: AgentCostSnapshot[];
	let renders: ReturnType<typeof mock>;
	let notices: ReturnType<typeof mock>;
	let ctx: any;

	function context(id: string, cost = 1) {
		const statuses = new Map<string, string>();
		const entries = [
			{ type: "usage", id: "usage", parentId: null, usage: { input: 10, output: 2, cost: { total: cost } } },
		];
		return {
			hasUI: true,
			statuses,
			cwd: "/test-project",
			model: { name: "test-model", contextWindow: 100000 },
			modelRegistry: { find: () => undefined },
			sessionManager: {
				getEntries: mock(() => entries),
				getBranch: mock(() => []),
				getSessionId: () => id,
				getSessionName: () => undefined,
				getLeafId: () => "usage",
			},
			getContextUsage: mock(() => ({ tokens: 100, percent: 0.1, contextWindow: 100000 })),
			getSystemPrompt: () => "",
			ui: {
				theme,
				notify: notices,
				setWorkingVisible: () => {},
				setFooter: (factory: Handler) =>
					factory({ requestRender: renders }, theme, {
						onBranchChange: () => () => {},
						getExtensionStatuses: () => statuses,
					}),
			},
		};
	}

	function status() {
		return chrome?.(240, theme, { modeReserve: 0 }).bottomRight ?? "";
	}

	function top() {
		return chrome?.(240, theme, { modeReserve: 0 }).topRight ?? "";
	}

	function snapshot(provider: string, usedPercent = 37): usage.UsageSnapshot {
		return {
			provider,
			windows: [{ label: "Week", usedPercent, windowSecs: 604800, resetSecs: 3600 }],
			fetchedAt: Date.now(),
		};
	}

	function auto(...providers: string[]) {
		ctx.model = { provider: "routing", id: "auto", api: "pi-virtual", name: "Auto", contextWindow: 0 };
		ctx.sessionManager.getBranch.mockReturnValue(
			providers.map((provider) => ({ type: "message", message: { role: "assistant", provider, model: "physical" } })),
		);
		spyOn(config, "loadConfig").mockReturnValue({ ...config.defaultConfig, usageBars: { visible: true } });
	}

	beforeEach(() => {
		handlers = new Map();
		commands = new Map();
		timers = new Set();
		children = [{ id: "/root/worker", cost: 0.25, status: "running" }];
		renders = mock(() => {});
		notices = mock(() => {});
		chrome = undefined;
		spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, interval: number) => {
			const timer = { callback, interval, unref: mock(() => {}) };
			timers.add(timer);
			return timer;
		}) as any);
		spyOn(globalThis, "clearInterval").mockImplementation(((timer: Timer) => timers.delete(timer)) as any);
		spyOn(config, "loadConfig").mockReturnValue(config.defaultConfig);
		spyOn(config, "ensureConfigExists").mockImplementation(() => {});
		spyOn(config, "saveConfig").mockImplementation(() => {});
		spyOn(usage, "fetchUsageForProvider").mockImplementation(async (provider) => snapshot(provider));
		spyOn(terminal, "terminalRows").mockReturnValue(40);
		spyOn(cursor, "installFocusCursor").mockReturnValue(() => {});
		spyOn(editor, "installEditorComposition").mockImplementation(() => {});
		spyOn(editor, "setWorkingAnimationState").mockImplementation(() => {});
		spyOn(editor, "setEditorChromeProvider").mockImplementation((provider) => {
			chrome = provider;
		});
		spyOn(editor, "setEditorSessionIdentityProvider").mockImplementation(() => {});
		spyOn(git, "readGitStatus").mockResolvedValue({} as any);
		spyOn(runtime, "readRuntimeInfo").mockResolvedValue(undefined as any);
		installCoordinatorLookup((id) => (id === "first" ? { snapshot: () => children } : undefined));
		ctx = context("first");
		extension({
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
			registerMessageRenderer: () => {},
			registerEntryRenderer: () => {},
		} as any);
	});

	afterEach(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		installCoordinatorLookup(() => undefined);
		mock.restore();
	});

	test("Auto restores quota from the last physical response and uses native physical context limits", async () => {
		auto("anthropic", "openai-codex");
		ctx.getContextUsage.mockReturnValue({ tokens: 25000, contextWindow: 200000, percent: 12.5 });
		await handlers.get("session_start")!({}, ctx);
		expect(usage.fetchUsageForProvider).toHaveBeenCalledTimes(1);
		expect(usage.fetchUsageForProvider).toHaveBeenCalledWith("codex");
		expect(top()).toContain("OpenAI Week");
		expect(top()).toContain("37%");
		expect(status()).toContain("12.5% 25k/200k");
		expect(status()).toContain("━");
		expect([...timers].some((timer) => timer.interval === usage.USAGE_REFRESH_INTERVAL)).toBe(true);
	});

	test("a newly routed response switches quota once, without fetching on every streaming update", async () => {
		auto("openai-codex");
		await handlers.get("session_start")!({}, ctx);
		const message = { role: "assistant", provider: "anthropic", model: "physical", content: [] };
		await handlers.get("message_start")!({ message }, ctx);
		expect(top()).toContain("Anthropic Week");
		expect(top()).not.toContain("OpenAI Week");
		for (let i = 0; i < 3; i++) await handlers.get("message_update")!({ message }, ctx);
		expect(usage.fetchUsageForProvider).toHaveBeenCalledTimes(2);
		expect(usage.fetchUsageForProvider).toHaveBeenLastCalledWith("claude");
		[...timers].find((timer) => timer.interval === usage.USAGE_REFRESH_INTERVAL)!.callback();
		expect(usage.fetchUsageForProvider).toHaveBeenLastCalledWith("claude");
	});

	test("branch navigation switches providers and clears quota on an empty branch", async () => {
		auto("openai-codex");
		await handlers.get("session_start")!({}, ctx);
		ctx.sessionManager.getBranch.mockReturnValue([
			{ type: "message", message: { role: "assistant", provider: "anthropic" } },
			{ type: "compaction" },
		]);
		await handlers.get("session_tree")!({}, ctx);
		expect(top()).toContain("Anthropic Week");
		ctx.sessionManager.getBranch.mockReturnValue([]);
		await handlers.get("session_tree")!({}, ctx);
		expect(top()).not.toContain("Week");
		expect([...timers].some((timer) => timer.interval === usage.USAGE_REFRESH_INTERVAL)).toBe(false);
	});

	test("a fresh virtual session waits for physical dispatch instead of inventing a provider", async () => {
		auto();
		await handlers.get("session_start")!({}, ctx);
		expect(usage.fetchUsageForProvider).not.toHaveBeenCalled();
		const message = { role: "assistant", provider: "openai-codex", content: [] };
		await handlers.get("message_start")!({ message }, ctx);
		expect(top()).toContain("OpenAI Week");
	});

	test("other virtual models also use physical dispatch, while direct models use their selection", async () => {
		auto("anthropic");
		ctx.model = { ...ctx.model, provider: "other-router", id: "smart" };
		await handlers.get("session_start")!({}, ctx);
		expect(top()).toContain("Anthropic Week");
		ctx.model = { provider: "openai-codex", id: "direct", name: "Direct", contextWindow: 100000 };
		await handlers.get("model_select")!({ model: ctx.model }, ctx);
		expect(top()).toContain("OpenAI Week");
		ctx.model = { ...ctx.model, provider: "unsupported" };
		await handlers.get("model_select")!({ model: ctx.model }, ctx);
		expect(top()).not.toContain("Week");
	});

	test("enabling bars under Auto refreshes the physical provider and persists the visibility", async () => {
		auto("openai-codex");
		await handlers.get("session_start")!({}, ctx);
		await commands.get("usage-bars")!.handler("off", ctx);
		expect(top()).not.toContain("Week");
		await commands.get("usage-bars")!.handler("on", ctx);
		expect(top()).toContain("OpenAI Week");
		expect(usage.fetchUsageForProvider).toHaveBeenLastCalledWith("codex");
		expect(config.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ usageBars: { visible: true } }));
	});

	test("late quota responses cannot overwrite a different routed provider", async () => {
		let finish!: (value: usage.UsageSnapshot) => void;
		spyOn(usage, "fetchUsageForProvider").mockImplementation((provider) =>
			provider === "codex"
				? new Promise((resolve) => {
						finish = resolve;
					})
				: Promise.resolve(snapshot(provider)),
		);
		auto("openai-codex");
		await handlers.get("session_start")!({}, ctx);
		await handlers.get("message_start")!({ message: { role: "assistant", provider: "anthropic" } }, ctx);
		finish(snapshot("codex", 99));
		await Promise.resolve();
		expect(top()).toContain("Anthropic Week");
		expect(top()).not.toContain("99%");
	});

	test("session switches ignore a prior session's late response even for the same provider", async () => {
		let finish!: (value: usage.UsageSnapshot) => void;
		spyOn(usage, "fetchUsageForProvider").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		auto("openai-codex");
		await handlers.get("session_start")!({}, ctx);
		await handlers.get("session_start")!({}, ctx);
		finish(snapshot("codex", 99));
		await Promise.resolve();
		expect(top()).toContain("37%");
		expect(top()).not.toContain("99%");
	});

	test("post-compaction unknown usage retains the physical window and marks the context estimate", async () => {
		auto("openai-codex");
		ctx.getContextUsage.mockReturnValue({ tokens: null, contextWindow: 200000, percent: null });
		ctx.getSystemPrompt = () => "x".repeat(4000);
		await handlers.get("session_start")!({}, ctx);
		expect(status()).toContain("~0.5% ~1k/200k");
	});

	test("fast mode status appears beside the model and disappears without rebuilding context", async () => {
		await handlers.get("session_start")!({}, ctx);
		expect(chrome?.(240, theme, { modeReserve: 0 }).topRight).not.toContain("· fast");
		ctx.statuses.set("openai-fast-mode", "fast");
		expect(chrome?.(240, theme, { modeReserve: 0 }).topRight).toContain("test-model · fast");
		ctx.statuses.delete("openai-fast-mode");
		expect(chrome?.(240, theme, { modeReserve: 0 }).topRight).not.toContain("· fast");
	});

	test("Auto shows live physical model status, queued requests, and fast mode without rebuilding context", async () => {
		ctx.model = { ...ctx.model, provider: "routing", id: "auto", name: "Auto — Luna routing" };
		await handlers.get("session_start")!({}, ctx);
		const top = (width = 240) => chrome?.(width, theme, { modeReserve: 0 }).topRight ?? "";
		expect(top()).toContain("Auto — Luna routing");
		const reads = ctx.getContextUsage.mock.calls.length;
		ctx.statuses.set("routing", "Auto → execution-astra · fixture (astra held)");
		expect(top()).toContain("Auto → execution-astra · fixture (astra held)");
		expect(top()).not.toContain("Luna routing");
		ctx.statuses.set("routing", "Auto → execution-astra · fixture (astra held) (reset queued)");
		expect(top()).toContain("reset queued");
		ctx.statuses.set("routing", "Auto → execution-sol · fixture (sol held)");
		ctx.statuses.set("openai-fast-mode", "fast");
		expect(top()).toContain("Auto → execution-sol · fixture (sol held) · fast");
		expect(top()).not.toContain("execution-astra");
		expect(ctx.getContextUsage.mock.calls.length).toBe(reads);
		for (let width = 1; width <= 100; width++) expect(visibleWidth(top(width))).toBeLessThanOrEqual(width);
		expect(top(40)).toContain("execution-sol");
		spyOn(terminal, "terminalRows").mockReturnValue(10);
		expect(top()).toContain("execution-sol");
	});

	test("physical selection and session switches cannot inherit an Auto label", async () => {
		ctx.statuses.set("routing", "Child Auto");
		await handlers.get("session_start")!({}, ctx);
		const top = () => chrome?.(240, theme, { modeReserve: 0 }).topRight ?? "";
		expect(top()).toContain("test-model");
		expect(top()).not.toContain("Child Auto");
		ctx.model = { ...ctx.model, provider: "routing", id: "auto" };
		ctx.statuses.set("routing", "Auto → execution-astra · fixture (astra held)");
		await handlers.get("model_select")!({ model: ctx.model }, ctx);
		expect(top()).toContain("execution-astra");
		ctx.model = { name: "manual-model", contextWindow: 100000 };
		await handlers.get("model_select")!({ model: ctx.model }, ctx);
		expect(top()).toContain("manual-model");
		expect(top()).not.toContain("execution-astra");
		const second = context("second");
		second.model = { ...second.model, provider: "routing", id: "auto", name: "New Auto" } as any;
		await handlers.get("session_start")!({}, second);
		expect(top()).toContain("New Auto");
		expect(top()).not.toContain("execution-astra");
	});

	test("child-only cost updates refresh the idle parent's editor without rebuilding context", async () => {
		await handlers.get("session_start")!({}, ctx);
		expect(status()).toContain("$1.25");
		expect(status()).toContain("agents $0.25");
		const contextReads = ctx.getContextUsage.mock.calls.length;
		const beforeRenders = renders.mock.calls.length;
		children[0].cost = 2.5;
		const timer = [...timers].find((timer) => timer.interval === 1000)!;
		expect(timer.unref).toHaveBeenCalledTimes(1);
		timer.callback();
		expect(status()).toContain("$3.50");
		expect(status()).toContain("agents $2.50");
		expect(renders.mock.calls.length).toBeGreaterThan(beforeRenders);
		expect(ctx.getContextUsage.mock.calls.length).toBe(contextReads);
	});

	test("session switch replaces the polling context and shutdown removes its timer", async () => {
		await handlers.get("session_start")!({}, ctx);
		const firstTimer = [...timers][0];
		const firstReads = ctx.sessionManager.getEntries.mock.calls.length;
		const second = context("second", 9);
		await handlers.get("session_start")!({}, second);
		expect(timers.has(firstTimer)).toBe(false);
		expect(timers.size).toBe(1);
		const secondTimer = [...timers][0];
		secondTimer.callback();
		expect(status()).toContain("$9.00");
		expect(status()).not.toContain("agents");
		expect(ctx.sessionManager.getEntries.mock.calls.length).toBe(firstReads);
		await handlers.get("session_shutdown")!({}, second);
		expect(timers.size).toBe(0);
		const readsAfterShutdown = second.sessionManager.getEntries.mock.calls.length;
		secondTimer.callback(); // Already queued callbacks must also be inert.
		expect(second.sessionManager.getEntries.mock.calls.length).toBe(readsAfterShutdown);
		expect(chrome).toBeUndefined();
	});

	test("headless subagents cannot replace or clear the parent's cost display", async () => {
		await handlers.get("session_start")!({}, ctx);
		const childHandlers = new Map<string, Handler>();
		extension({
			on: (event: string, handler: Handler) => childHandlers.set(event, handler),
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			registerEntryRenderer: () => {},
		} as any);
		const child = context("child", 0);
		child.hasUI = false;
		await childHandlers.get("session_start")!({}, child);
		expect(status()).toContain("$1.25");
		expect(editor.installEditorComposition).toHaveBeenCalledTimes(1);
		expect(timers.size).toBe(1);

		child.sessionManager.getEntries.mockReturnValue([
			{ type: "usage", id: "child-usage", parentId: null, usage: { input: 10, output: 2, cost: { total: 9 } } },
		]);
		await childHandlers.get("agent_start")!({}, child);
		await childHandlers.get("message_update")!({ message: {} }, child);
		await childHandlers.get("agent_end")!({}, child);
		await childHandlers.get("session_shutdown")!({}, child);
		expect(status()).toContain("$1.25");
		expect(editor.setWorkingAnimationState).not.toHaveBeenCalled();
		expect(timers.size).toBe(1);
	});

	test("a stale session context stops polling instead of repeatedly throwing", async () => {
		await handlers.get("session_start")!({}, ctx);
		ctx.sessionManager.getEntries.mockImplementation(() => {
			throw new Error("ctx is stale");
		});
		expect(() => [...timers][0].callback()).not.toThrow();
		expect(timers.size).toBe(0);
	});

	test("session_tree refreshes cost immediately and /cost reports current nested-agent breakdown", async () => {
		await handlers.get("session_start")!({}, ctx);
		children.push({ id: "/root/worker/nested", cost: 0.75, status: "completed" });
		await handlers.get("session_tree")!({}, ctx);
		expect(status()).toContain("$2.00");
		children[0].cost = 2;
		await commands.get("cost")!.handler("", ctx);
		const [report, level] = notices.mock.calls.at(-1)!;
		expect(level).toBe("info");
		expect(report).toContain("Session cost (list-price estimate): $3.75");
		expect(report).toContain("This agent: $1.00");
		expect(report).toContain("Subagents (including nested): $2.75");
		expect(report).toContain("/root/worker/nested: $0.75 (completed)");
		expect(report).toContain("not subscription billing");
	});

	test("accounting failures pause polling and mark the last total rather than crashing Pi", async () => {
		await handlers.get("session_start")!({}, ctx);
		ctx.sessionManager.getEntries.mockImplementation(() => {
			throw new Error("unavailable ledger");
		});
		expect(() => [...timers][0].callback()).not.toThrow();
		expect(timers.size).toBe(0);
		expect(status()).toContain("$1.25 ?");
		expect(notices.mock.calls.at(-1)).toEqual(["Cost updates paused: unavailable ledger. Reload to retry.", "warning"]);
	});
});

describe("cost context-status rendering", () => {
	const state = {
		...emptyFooterState(),
		contextTotal: 100000,
		contextUsed: 1000,
		contextPercent: 1,
		hasCost: true,
		costLabel: "$3.75",
		agentCostLabel: "agents $2.75",
	};
	test("wide status includes total and agent breakdown", () => {
		const line = renderEditorContextStatus(state, theme, 100);
		expect(line).toContain("$3.75");
		expect(line).toContain("agents $2.75");
	});
	test("narrow widths preserve total when it fits and never overflow", () => {
		for (let width = 1; width <= 100; width++) {
			const line = renderEditorContextStatus(state, theme, width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (width >= 5) expect(line).toContain("$3.75");
		}
	});
	test("cost remains visible without an active model", () => {
		expect(renderEditorContextStatus({ ...state, contextTotal: 0 }, theme, 20)).toBe("$3.75");
	});
});
