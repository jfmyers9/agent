import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCodeModeToolAdapterRegistry } from "@luan.sh/pi-code-mode/sdk";
import { Type } from "typebox";
import { boundShellToolResult } from "../exec-command/tools/output-truncation.ts";
import { createToolToggleController } from "../token-burden/tool-toggles.ts";
import { isToolLifted, listSessionLiftedTools, registerCodeModeTool, setCodeModeToolPolicy } from "./code-mode.ts";

function fixture() {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const definitions = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			definitions.set(tool.name, tool);
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const ctx = { sessionManager: {}, cwd: "/tmp" } as ExtensionContext;
	const emit = (event: string, payload = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		if (event === "session_start") getCodeModeToolAdapterRegistry().claim(ctx.sessionManager, ctx.sessionManager);
	};
	const adapter = (name: string) =>
		getCodeModeToolAdapterRegistry()
			.list(ctx.sessionManager)
			.find((item) => item.owner === definitions.get(name)) ??
		getCodeModeToolAdapterRegistry()
			.list()
			.find((item) => item.owner === definitions.get(name))!;
	return { pi, ctx, emit, adapter, call: { cwd: "/tmp", toolCallId: "nested-test", extensionContext: ctx } };
}

test("nested tools validate arguments and preserve text alongside rendering metadata", async () => {
	const f = fixture();
	let calls = 0;
	registerCodeModeTool(f.pi, {
		name: "read-test",
		label: "Read",
		description: "Read",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_id, params) {
			calls++;
			return { content: [{ type: "text", text: params.path }], details: { rows: [] } };
		},
	});
	try {
		const adapter = f.adapter("read-test");
		expect(() => adapter.prepareInput!({})).toThrow();
		expect(calls).toBe(0);
		const result = await adapter.invoke(
			adapter.prepareInput!({ path: "file contents" }),
			f.call,
			new AbortController().signal,
		);
		expect(adapter.resultValue!(result)).toEqual({
			content: [{ type: "text", text: "file contents" }],
			details: { rows: [] },
		});
		expect(calls).toBe(1);
	} finally {
		f.emit("session_shutdown", { reason: "quit" });
	}
});

test("nested failures publish partial results before rejecting", async () => {
	const f = fixture();
	registerCodeModeTool(f.pi, {
		name: "patch-test",
		label: "Patch",
		description: "Patch",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "Updated a; failed b" }],
				details: { error: true, completedPaths: ["a"] },
			};
		},
	});
	try {
		const updates: unknown[] = [];
		await expect(
			f
				.adapter("patch-test")
				.invoke({}, { ...f.call, onUpdate: (result) => updates.push(result) }, new AbortController().signal),
		).rejects.toThrow("Updated a; failed b");
		expect(updates).toHaveLength(1);
	} finally {
		f.emit("session_shutdown", { reason: "quit" });
	}
});

test("re-registering an edit mode preserves its claimed session and replaces execution", async () => {
	const f = fixture();
	const register = (value: string) =>
		registerCodeModeTool(f.pi, {
			name: "edit-refresh-test",
			label: "Edit",
			description: "Edit",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: value }], details: {} };
			},
		});
	register("old mode");
	f.emit("session_start");
	register("new mode");
	try {
		const adapter = getCodeModeToolAdapterRegistry()
			.list(f.ctx.sessionManager)
			.find((entry) => entry.name === "edit-refresh-test")!;
		expect(adapter).toBeDefined();
		const result = await adapter.invoke({}, f.call, new AbortController().signal);
		expect(result.content).toEqual([{ type: "text", text: "new mode" }]);
	} finally {
		f.emit("session_shutdown", { reason: "quit" });
	}
});

test("lift and disabled policy are isolated by owner and session", async () => {
	const first = fixture();
	const second = fixture();
	for (const f of [first, second]) {
		registerCodeModeTool(f.pi, {
			name: "owner-test",
			label: "Owner",
			description: "Owner",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		});
		f.emit("session_start");
	}
	try {
		first.adapter("owner-test").onScopeChange!({ tools: () => [], active: () => [], setActive: () => {} });
		expect(isToolLifted(first.pi, "owner-test")).toBe(true);
		expect(isToolLifted(second.pi, "owner-test")).toBe(false);
		expect(listSessionLiftedTools(first.ctx.sessionManager)).toEqual(["owner-test"]);
		expect(listSessionLiftedTools(second.ctx.sessionManager)).toEqual([]);
		setCodeModeToolPolicy(first.ctx.sessionManager, () => true);
		await expect(first.adapter("owner-test").invoke({}, first.call, new AbortController().signal)).rejects.toThrow(
			"disabled",
		);
		await expect(
			second.adapter("owner-test").invoke({}, second.call, new AbortController().signal),
		).resolves.toMatchObject({ details: {} });
	} finally {
		first.emit("session_shutdown", { reason: "quit" });
		second.emit("session_shutdown", { reason: "quit" });
	}
});

test("nested shell calls retain the direct result hook's output bounds and failure status", async () => {
	const f = fixture();
	registerCodeModeTool(
		f.pi,
		{
			name: "shell-test",
			label: "Shell",
			description: "Shell",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "x".repeat(60_000) }], details: { exit_code: 1 } };
			},
		},
		{ mapResult: boundShellToolResult },
	);
	try {
		const updates: any[] = [];
		await expect(
			f
				.adapter("shell-test")
				.invoke({}, { ...f.call, onUpdate: (result) => updates.push(result) }, new AbortController().signal),
		).rejects.toThrow("truncated");
		expect(updates[0].content[0].text.length).toBeLessThan(500);
	} finally {
		f.emit("session_shutdown", { reason: "quit" });
	}
});

test("toggling a lifted tool denies nested calls without restoring a direct schema", async () => {
	const f = fixture();
	let activeTools = ["exec"];
	Object.assign(f.pi, {
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
	});
	registerCodeModeTool(f.pi, {
		name: "toggle-test",
		label: "Toggle",
		description: "Toggle",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
	const controller = createToolToggleController(f.pi, []);
	controller.install();
	f.emit("session_start");
	f.adapter("toggle-test").onScopeChange!({ tools: () => [], active: () => [], setActive: () => {} });
	try {
		controller.setToolActive("toggle-test", false);
		await expect(f.adapter("toggle-test").invoke({}, f.call, new AbortController().signal)).rejects.toThrow("disabled");
		controller.setToolActive("toggle-test", true);
		expect(activeTools).toEqual(["exec"]);
		await expect(f.adapter("toggle-test").invoke({}, f.call, new AbortController().signal)).resolves.toMatchObject({
			details: {},
		});
	} finally {
		f.emit("session_shutdown", { reason: "quit" });
	}
});
