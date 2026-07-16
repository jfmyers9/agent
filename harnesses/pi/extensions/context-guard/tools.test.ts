import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPiContextTools } from "./pi/tools.js";

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;

afterEach(() => {
	if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
	else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
});

function registeredTools() {
	const tools = new Map<string, any>();
	registerPiContextTools({
		registerTool: (tool) => tools.set(tool.name, tool),
	});
	return tools;
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await Bun.file(path).exists()) return;
		await Bun.sleep(20);
	}
	expect(await Bun.file(path).exists()).toBe(true);
}

describe("context-guard tool registration", () => {
	it("exposes cg_fetch URL inputs to the model", () => {
		const fetch = registeredTools().get("cg_fetch");
		expect(fetch?.parameters).toMatchObject({
			type: "object",
			properties: {
				url: { type: "string" },
				timeout: { type: "integer", minimum: 100, maximum: 300_000 },
				requests: {
					type: "array",
					items: {
						type: "object",
						properties: { url: { type: "string" } },
					},
				},
			},
		});
	});

	it("limits cg_process_file to supported runtimes and omits intent", () => {
		const processFile = registeredTools().get("cg_process_file");
		expect(processFile.parameters.properties.language.enum).toEqual(["shell", "javascript", "typescript", "python"]);
		expect(processFile.parameters.properties.intent).toBeUndefined();
	});

	it("describes purge scopes without claiming unrelated files are removed", () => {
		const purge = registeredTools().get("cg_purge");
		expect(purge.description).toContain("session's state and telemetry");
		expect(purge.description).toContain("project's index and session database");
		expect(purge.description).not.toContain("per-session FTS5");
		expect(purge.description).not.toContain("events markdown");
		expect(purge.description).not.toContain("stats file");
	});

	it("passes cg_fetch timeout to the core", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-fetch-timeout-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(
			coreBin,
			`#!${process.execPath}\nlet input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const request = JSON.parse(input); process.stdout.write(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(request.params) }] })); });\n`,
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const result = await registeredTools()
			.get("cg_fetch")
			.execute("fetch", { url: "https://example.com", timeout: 321 });
		const params = JSON.parse(result.content[0].text);

		expect(params.timeout).toBe(321);
	});

	it("threads AbortSignal through direct cg tool handlers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-direct-abort-"));
		const coreBin = join(dir, "context-guard-core.js");
		const marker = join(dir, "started");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				'let input = "";',
				'process.stdin.on("data", chunk => input += chunk);',
				'process.stdin.on("end", () => {',
				"  const request = JSON.parse(input);",
				'  if (request.command === "session") {',
				'    process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "{}" }] }));',
				"    return;",
				"  }",
				`  require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`,
				"  setInterval(() => {}, 1000);",
				"});",
			].join("\n"),
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;
		const controller = new AbortController();
		const execution = registeredTools().get("cg_status").execute("status", {}, controller.signal);
		await waitForFile(marker);

		controller.abort();

		await expect(execution).rejects.toThrow("Context Guard core cancelled");
	});
});
