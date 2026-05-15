import { expect, test } from "bun:test";

import {
	isExplorationHidden,
	readAction,
	registerExplorationEventHandlers,
	registerExplorationTool,
	renderExplorationCall,
} from "./exploration-rendering";

const theme = {
	fg(_role: string, text: string) {
		return text;
	},
	bold(text: string) {
		return `**${text}**`;
	},
};

test("exploration grouping coalesces read and search tool calls", () => {
	const handlers = new Map<string, ((event: any) => void)[]>();
	const pi = {
		on(event: string, handler: (event: any) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const emit = (event: string, payload: any) => {
		for (const handler of handlers.get(event) ?? []) handler(payload);
	};

	registerExplorationTool("read", (args) =>
		readAction(typeof args === "object" && args && "path" in args ? String(args.path) : ""),
	);
	registerExplorationTool("grep", (args) => ({
		kind: "search",
		title: "Search",
		body: typeof args === "object" && args && "pattern" in args ? String(args.pattern) : "",
	}));
	registerExplorationEventHandlers(pi);

	emit("session_start", {});
	emit("tool_execution_start", {
		toolName: "read",
		toolCallId: "read-1",
		args: { path: "/tmp/a.ts" },
	});
	emit("tool_execution_start", {
		toolName: "grep",
		toolCallId: "grep-1",
		args: { pattern: "needle" },
	});
	emit("tool_execution_end", { toolName: "read", toolCallId: "read-1" });
	emit("tool_execution_end", { toolName: "grep", toolCallId: "grep-1" });

	expect(isExplorationHidden("read-1")).toBe(true);
	expect(
		renderExplorationCall({ kind: "search", title: "Search", body: "needle" }, theme, {
			toolCallId: "grep-1",
			isPartial: false,
		}),
	).toBe("• **Explored**\n  └ Read a.ts\n    Search needle");
});
