import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import { boundShellToolResult } from "./tools/output-truncation.ts";
import { formatUnifiedExecResult } from "./tools/unified-exec-format.ts";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function removeOutput(path: string | undefined): void {
	if (path) rmSync(dirname(path), { recursive: true, force: true });
}

test("preserves raw output beyond the display and buffer limits", async () => {
	const manager = createExecSessionManager();
	let path: string | undefined;
	const expected = `${"x".repeat(700_000)}\n\u001b[31m雪-middle-needle\u001b[0m\r\n${"y".repeat(700_000)}\n`;
	try {
		const script = 'process.stdout.write("x".repeat(700000) + "\\n\\u001b[31m雪-middle-needle\\u001b[0m\\r\\n" + "y".repeat(700000) + "\\n")';
		const result = await manager.exec(
			{ cmd: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`, login: false },
			process.cwd(),
		);
		path = result.full_output_path;
		expect(result.exit_code).toBe(0);
		expect(result.output_truncated).toBe(true);
		expect(result.output).not.toContain("middle-needle");
		expect(path).toBeString();
		expect(readFileSync(path!, "utf8")).toBe(expected);
		expect(statSync(path!).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);

		const bounded = boundShellToolResult({
			content: [{ type: "text" as const, text: formatUnifiedExecResult(result) }],
			details: result,
		});
		expect(bounded.content[0].text).toContain(`Full output: ${path}`);
		expect(bounded.details.full_output_path).toBe(path);
	} finally {
		manager.shutdown();
		removeOutput(path);
	}
});

test("keeps the full output file across polling and session shutdown", async () => {
	const manager = createExecSessionManager();
	let path: string | undefined;
	try {
		const first = await manager.exec(
			{ cmd: 'printf "before\\n"; read line; printf "%s\\n" "$line"', tty: true, login: false, yield_time_ms: 250 },
			process.cwd(),
		);
		path = first.full_output_path;
		expect(first.process_id).toBeNumber();
		expect(manager.getSessionSnapshot(first.process_id!)?.fullOutputPath).toBe(path);
		expect(readFileSync(path!, "utf8")).toBe("before\n");
		const last = await manager.write({ process_id: first.process_id!, chars: "after\n", yield_time_ms: 1000 });
		expect(last.exit_code).toBe(0);
		expect(last.full_output_path).toBe(path);
		manager.shutdown();
		expect(readFileSync(path!, "utf8")).toBe("before\nafter\n");
	} finally {
		manager.shutdown();
		removeOutput(path);
	}
});

test("preserves stdout and stderr from failed commands", async () => {
	const manager = createExecSessionManager();
	let path: string | undefined;
	try {
		const result = await manager.exec(
			{ cmd: 'printf "stdout-needle\\n"; printf "stderr-needle\\n" >&2; exit 7', login: false },
			process.cwd(),
		);
		path = result.full_output_path;
		expect(result.exit_code).toBe(7);
		const output = readFileSync(path!, "utf8");
		expect(output).toContain("stdout-needle\n");
		expect(output).toContain("stderr-needle\n");
	} finally {
		manager.shutdown();
		removeOutput(path);
	}
});

test("reports output persistence errors instead of claiming a complete log", async () => {
	const manager = createExecSessionManager();
	let path: string | undefined;
	try {
		const first = await manager.exec(
			{ cmd: 'printf "ready\\n"; read line; printf "later\\n"', tty: true, login: false, yield_time_ms: 250 },
			process.cwd(),
		);
		path = first.full_output_path;
		unlinkSync(path!);
		mkdirSync(path!);
		const last = await manager.write({ process_id: first.process_id!, chars: "continue\n", yield_time_ms: 1000 });
		expect(last.terminal_state).toBe("session_error");
		expect(last.session_error).toContain("Could not save command output");
		expect(last.exit_code).toBeUndefined();
		expect(last.full_output_path).toBeUndefined();
	} finally {
		manager.shutdown();
		removeOutput(path);
	}
});
