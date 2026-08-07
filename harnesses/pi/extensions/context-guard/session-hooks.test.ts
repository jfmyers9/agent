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
	it("keeps only telemetry lifecycle hooks", async () => {
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
				'  if (action === "build_pi_check") payload = "rust cg-check summary";',
				'  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: "text", text: JSON.stringify(payload) }] }));',
				"});",
			].join("\n"),
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPi();
		piExtension(pi);
		pi.hooks.get("session_start")?.({}, { sessionManager: { getSessionFile: () => join(dir, "session.json") } });
		const check = await pi.commands.get("cg-check")?.handler({});

		expect(pi.hooks.has("tool_call")).toBe(false);
		expect(pi.hooks.has("tool_result")).toBe(false);
		expect(pi.hooks.has("session_compact")).toBe(false);
		expect(pi.hooks.has("before_agent_start")).toBe(false);
		expect(pi.hooks.has("session_before_compact")).toBe(false);
		expect(check).toEqual({ text: "rust cg-check summary" });

		const requests = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						command: string;
						params?: {
							action?: string;
							projectDir?: string;
						};
					},
			);
		const actions = requests
			.filter((request) => request.command === "session")
			.map((request) => request.params?.action);
		for (const action of ["init", "build_pi_check"]) {
			expect(actions).toContain(action);
		}
		expect(requests.find((request) => request.params?.action === "init")?.params?.projectDir).toBe(projectDir);
	});
});
