import { describe, expect, test } from "bun:test";
import { buildSessionUsageData } from "./index";

function entry(id: string, parentId: string | null, message: Record<string, unknown>) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-10T00:00:00.000Z",
		message,
	};
}

describe("token-burden session usage", () => {
	test("splits tool-result usage by tool name", () => {
		const entries = [
			entry("u1", null, {
				role: "user",
				content: "please inspect files",
				timestamp: 0,
			}),
			entry("a1", "u1", {
				role: "assistant",
				content: [
					{ type: "text", text: "I will inspect them." },
					{ type: "toolCall", id: "tc1", name: "exec_command", arguments: { cmd: "rg foo" } },
					{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "file.ts" } },
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
				stopReason: "toolUse",
				timestamp: 0,
			}),
			entry("t1", "a1", {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "exec_command",
				content: [{ type: "text", text: "grep output ".repeat(20) }],
				isError: false,
				timestamp: 0,
			}),
			entry("t2", "t1", {
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "read",
				content: [{ type: "text", text: "file content ".repeat(20) }],
				isError: false,
				timestamp: 0,
			}),
		];

		const result = buildSessionUsageData({
			sessionManager: {
				getEntries: () => entries,
				getLeafId: () => "t2",
			},
			getContextUsage: () => undefined,
		} as any);

		expect(result?.categories.map((category) => category.label)).toContain("Tool result: exec_command(rg)");
		expect(result?.categories.map((category) => category.label)).toContain("Tool result: read");
		expect(result?.categories.find((category) => category.label === "Tool results")).toBeUndefined();
	});
});
