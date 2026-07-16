import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeCore, invokeCoreSync } from "./pi/core.js";

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;

afterEach(() => {
	if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
	else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
});

function processList(): string {
	return execFileSync("ps", ["-axo", "pid,ppid,pgid,stat,command"], { encoding: "utf8" });
}

async function waitForProcess(marker: string, present: boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (processList().includes(marker) === present) return;
		await Bun.sleep(50);
	}
	expect(processList().includes(marker)).toBe(present);
}

describe("invokeCore cancellation", () => {
	it("does not spawn the core for an already-aborted request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-pre-abort-"));
		const coreBin = join(dir, "context-guard-core.js");
		const markerPath = join(dir, "started");
		writeFileSync(
			coreBin,
			`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "yes");\n`,
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;
		const controller = new AbortController();
		controller.abort();

		const result = await invokeCore("batch", {}, controller.signal);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("cancelled");
		expect(await Bun.file(markerPath).exists()).toBe(false);
	});

	it.skipIf(process.platform === "win32")("terminates the core process group and descendants", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-abort-"));
		const coreBin = join(dir, "context-guard-core.js");
		const marker = `context-guard-abort-descendant-${process.pid}-${Date.now()}`;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				'const { spawn } = require("node:child_process");',
				`const marker = ${JSON.stringify(marker)};`,
				"process.stdin.resume();",
				'process.stdin.on("end", () => {',
				'  spawn("sh", ["-c", "sleep 30 # " + marker], { stdio: "ignore", detached: true });',
				"  setInterval(() => {}, 1000);",
				"});",
			].join("\n"),
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;
		const controller = new AbortController();
		const execution = invokeCore("batch", {}, controller.signal);

		await waitForProcess(marker, true);
		controller.abort();
		const result = await Promise.race([
			execution,
			Bun.sleep(1500).then(() => {
				throw new Error("invokeCore did not abort promptly");
			}),
		]);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Context Guard core cancelled");
		await waitForProcess(marker, false);
	});

	it("times out an unresponsive async core", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-timeout-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(coreBin, `#!${process.execPath}\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const result = await invokeCore("batch", { timeout: 1 });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("timed out after 1001ms");
	});

	it("bounds synchronous core calls used by hooks", () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-sync-timeout-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(coreBin, `#!${process.execPath}\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const started = Date.now();
		const result = invokeCoreSync("session", {});

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("timed out after 2000ms");
		expect(Date.now() - started).toBeLessThan(4000);
	});

	it("rejects excessive core output without accumulating it indefinitely", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-output-limit-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(coreBin, `#!${process.execPath}\nprocess.stdout.write("x".repeat(9 * 1024 * 1024));\n`);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const result = await invokeCore("status");

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("output exceeded 8388608 bytes");
	});
});
