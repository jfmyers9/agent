import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piExtension from "./index.js";
import { resetExecCommandContextGuardEnabled } from "./pi/index.js";

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalPiConfigDir = process.env.PI_CONFIG_DIR;
const originalWorkspaceDir = process.env.PI_WORKSPACE_DIR;

afterEach(() => {
	for (const [name, value] of [
		["CONTEXT_GUARD_BIN", originalCoreBin],
		["PI_CONFIG_DIR", originalPiConfigDir],
		["PI_WORKSPACE_DIR", originalWorkspaceDir],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	resetExecCommandContextGuardEnabled();
});

function createMockPi() {
	const hooks = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	return {
		hooks,
		commands,
		on(name: string, handler: (...args: any[]) => any) {
			hooks.set(name, handler);
		},
		registerCommand(name: string, def: { handler: (...args: any[]) => any }) {
			commands.set(name, def);
		},
		registerTool() {},
	};
}

describe("Pi session hook delegation", () => {
	it("keeps session actions on the Rust core and injects its resume state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-session-hooks-"));
		const coreBin = join(dir, "context-guard-core.js");
		const logPath = join(dir, "requests.log");
		const projectDir = join(dir, "project");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		process.env.PI_CONFIG_DIR = join(dir, "config");
		process.env.PI_WORKSPACE_DIR = projectDir;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				'const fs = require("node:fs");',
				`const logPath = ${JSON.stringify(logPath)};`,
				'let input = "";',
				'process.stdin.setEncoding("utf8");',
				'process.stdin.on("data", chunk => input += chunk);',
				'process.stdin.on("end", () => {',
				"  const request = JSON.parse(input);",
				'  fs.appendFileSync(logPath, JSON.stringify(request) + "\\n");',
				"  const action = request.params?.action;",
				"  let payload = {};",
				'  if (action === "extract_hook_events") payload = [{ type: "tool_call", category: "pi", data: "captured", priority: 1 }];',
				'  if (action === "check_tool_call") payload = { block: request.params?.hookInput?.tool_input?.command?.includes("curl "), reason: "blocked from rust" };',
				'  if (action === "prepare_before_agent_start") payload = { systemPrompt: "base prompt\\n\\n<session_state>rust owned</session_state>\\n\\n<resume>carry this forward</resume>" };',
				'  if (action === "prepare_before_compact") payload = { eventCount: 1, snapshot: "<resume>carry this forward</resume>" };',
				'  if (action === "build_pi_check") payload = "rust cg-check summary";',
				'  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: "text", text: JSON.stringify(payload) }] }));',
				"});",
			].join("\n"),
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPi();
		piExtension(pi);
		pi.hooks.get("session_start")?.({}, { sessionManager: { getSessionFile: () => join(dir, "session.json") } });
		const blocked = pi.hooks.get("tool_call")?.({ toolName: "bash", input: { command: "curl https://example.com" } });
		pi.hooks.get("tool_result")?.({ toolName: "read", input: { path: "README.md" }, result: "content" });
		pi.hooks.get("before_provider_response")?.({ model: "gpt-test", provider: "openai" });
		const beforeStart = pi.hooks.get("before_agent_start")?.({ prompt: "continue", systemPrompt: "base prompt" });
		pi.hooks.get("session_before_compact")?.();
		const check = await pi.commands.get("cg-check")?.handler({});

		expect(blocked).toEqual({ block: true, reason: "blocked from rust" });
		expect(beforeStart?.systemPrompt).toContain("<session_state>rust owned</session_state>");
		expect(beforeStart?.systemPrompt).toContain("<resume>carry this forward</resume>");
		expect(check).toEqual({ text: "rust cg-check summary" });

		const requests = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { command: string; params?: { action?: string; projectDir?: string } });
		const actions = requests
			.filter((request) => request.command === "session")
			.map((request) => request.params?.action);
		for (const action of [
			"init",
			"check_tool_call",
			"extract_hook_events",
			"events",
			"record_provider_response",
			"prepare_before_agent_start",
			"prepare_before_compact",
			"build_pi_check",
		]) {
			expect(actions).toContain(action);
		}
		expect(requests.find((request) => request.params?.action === "init")?.params?.projectDir).toBe(projectDir);
	});
});
