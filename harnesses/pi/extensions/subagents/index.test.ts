import { afterEach, expect, test } from "bun:test";
import { handleForkIntoTmuxSplit } from "../fork-split.ts";
import subagentsExtension from "./index.ts";
import { hasActiveSubagents, installCoordinatorLookup } from "./runtime.ts";

afterEach(() => installCoordinatorLookup(() => undefined));

test("loads the installed subagent extension and exposes all collaboration tools", async () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	await subagentsExtension({
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string) => commands.push(name),
		registerMessageRenderer: () => {},
		on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
	} as any);
	expect(tools.sort()).toEqual([
		"followup_task",
		"interrupt_agent",
		"list_agents",
		"send_message",
		"spawn_agent",
		"wait_agent",
	]);
	expect(commands).toContain("subagents");
	expect(handlers.has("session_before_fork")).toBe(true);
	await handlers.get("session_shutdown")?.({ reason: "quit" });
});

test("tmux forks refuse active children before creating files or terminal lanes", async () => {
	for (const status of ["queued", "running"]) {
		installCoordinatorLookup((id) =>
			id === "active-session" ? { snapshot: () => [{ id: "/root/worker", status }] } : undefined,
		);
		const notices: string[] = [];
		const result = await handleForkIntoTmuxSplit(
			{} as any,
			{ type: "session_before_fork", entryId: "user-entry", position: "before" },
			{
				hasUI: true,
				sessionManager: { getSessionId: () => "active-session" },
				ui: { notify: (message: string) => notices.push(message) },
			} as any,
			"%1",
		);
		expect(result).toEqual({ cancel: true });
		expect(notices).toEqual(["Wait for or interrupt active subagents before forking the session."]);
		expect(hasActiveSubagents("unrelated-session")).toBe(false);
	}
});

test("root activity and settled children do not prevent forks", () => {
	installCoordinatorLookup(() => ({
		snapshot: () => [
			{ id: "/root", status: "running" },
			{ id: "/root/finished", status: "completed" },
			{ id: "/root/stopped", status: "interrupted" },
			{ id: "/root/broken", status: "failed" },
		],
	}));
	expect(hasActiveSubagents("session")).toBe(false);
});

test("patched child tool selection preserves lifting, deferral, and the parent allowlist", async () => {
	const runner = await import(new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href);
	expect(
		runner.resolveChildActiveToolNames(
			["exec", "tool_search", "read", "apply_patch", "cg_status"],
			["exec", "tool_search", "unrelated_tool"],
		),
	).toEqual(["exec", "tool_search"]);
});

test("lifted tools belong to their parent session, not sibling sessions", async () => {
	const hierarchy = await import(new URL("./protocol/hierarchy.ts", import.meta.resolve("@luan.sh/pi-code-mode")).href);
	const parent = {};
	const sibling = {};
	const parentScope = Symbol("parent");
	const siblingScope = Symbol("sibling");
	try {
		hierarchy.setLiftedToolNames(parentScope, ["read"], parent);
		hierarchy.setLiftedToolNames(siblingScope, ["private_sibling_tool"], sibling);
		expect(hierarchy.listLiftedToolNames(parent)).toEqual(["read"]);
		expect(hierarchy.listLiftedToolNames(sibling)).toEqual(["private_sibling_tool"]);
		expect(hierarchy.listLiftedToolNames({})).toEqual([]);
	} finally {
		hierarchy.setLiftedToolNames(parentScope, []);
		hierarchy.setLiftedToolNames(siblingScope, []);
	}
});
