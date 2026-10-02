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

test("child tool selection preserves the parent allowlist and child deactivations", async () => {
	const runner = await import(new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href);
	expect(
		runner.resolveChildActiveToolNames(
			["codemode", "read", "apply_patch", "cg_status"],
			["codemode", "read", "unrelated_tool"],
		),
	).toEqual(["codemode", "read"]);
});

test("children inherit native codemode and its active underlying tools", async () => {
	const runner = await import(new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href);
	const activeTools = ["codemode", "read", "apply_patch", "spawn_agent"];
	const prepared = await runner.prepareAgentRun(
		{ cwd: process.cwd(), getSystemPrompt: () => "Parent instructions" },
		{
			pi: { getActiveTools: () => activeTools, getAllTools: () => [], getThinkingLevel: () => "off" },
			agentConfig: {},
		},
		false,
	);
	expect(prepared.toolNames).toEqual(activeTools);
});

test("children retain inactive callable tools without activating them", async () => {
	const runner = await import(new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href);
	const activeTools = ["codemode", "read"];
	const prepared = await runner.prepareAgentRun(
		{ cwd: process.cwd(), getSystemPrompt: () => "Parent instructions" },
		{
			pi: {
				getActiveTools: () => activeTools,
				getAllTools: () => [
					{ name: "read", exposure: "direct" },
					{ name: "spawn_agent", exposure: "codemode" },
					{ name: "cg_status", exposure: "deferred" },
					{ name: "disabled_tool", exposure: "direct" },
				],
				getThinkingLevel: () => "off",
			},
			agentConfig: {},
		},
		false,
	);
	expect(prepared.toolNames).toEqual(["codemode", "read", "spawn_agent", "cg_status"]);
	expect(prepared.parentActiveToolNames).toEqual(activeTools);
	// The SDK initially activates explicit tools; restore the parent's active subset.
	expect(runner.resolveChildActiveToolNames(prepared.parentActiveToolNames, prepared.toolNames)).toEqual(activeTools);
});
