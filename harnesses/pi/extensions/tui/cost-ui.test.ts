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
		const entries = [
			{ type: "usage", id: "usage", parentId: null, usage: { input: 10, output: 2, cost: { total: cost } } },
		];
		return {
			cwd: "/test-project",
			model: { name: "test-model", contextWindow: 100000 },
			modelRegistry: { find: () => undefined },
			sessionManager: {
				getEntries: mock(() => entries),
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
				setFooter: (factory: Handler) => factory({ requestRender: renders }, theme, { onBranchChange: () => () => {} }),
			},
		};
	}

	function status() {
		return chrome?.(240, theme, { modeReserve: 0 }).bottomRight ?? "";
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
		spyOn(terminal, "terminalRows").mockReturnValue(40);
		spyOn(cursor, "installFocusCursor").mockReturnValue(() => {});
		spyOn(editor, "installEditorComposition").mockImplementation(() => {});
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
		expect(notices.mock.calls.at(-1)).toEqual([
			"Cost updates paused: unavailable ledger. Reload to retry.",
			"warning",
		]);
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
