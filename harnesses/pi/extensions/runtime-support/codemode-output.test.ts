import { expect, test } from "bun:test";
import { formatUnifiedExecResult } from "../exec-command/tools/unified-exec-format";
import { formatFailure, formatOutput } from "./codemode-output";

const wrap = (text: string, details?: unknown, isError?: boolean) =>
	JSON.stringify({ content: [{ type: "text", text }], details, isError });
const execution = (output: string, extra = {}) => ({
	chunk_id: "sample",
	wall_time_seconds: 0.025,
	output,
	exit_code: 0,
	...extra,
});

test("rejected exec exceptions normalize labels and prioritize stderr without duplicates", () => {
	const raw = formatUnifiedExecResult(execution("first\nsecond\n\nstderr:\nfailed here\n", { exit_code: 1 }), "demo");
	for (const prefix of ["", "Error: ", "Expected demo failure:\nError: "]) {
		const parsed = formatFailure(prefix + raw)!;
		expect(parsed.text).toBe("stderr:\nfailed here\n\nfirst\nsecond");
		expect(parsed.notices).toEqual([{ text: "Process exited with code 1", level: "error" }]);
	}
	expect(formatOutput(`Error: ${raw}`).text).toBe(`Error: ${raw}`);
});

test("failure normalization leaves unrelated and incomplete exceptions alone", () => {
	for (const raw of ["Error: missing file", "Expected error:\nCommand: example\nOutput:\ndata", "ordinary output"])
		expect(formatFailure(raw)).toBeUndefined();
	expect(formatFailure(formatUnifiedExecResult(execution("success"), "demo"))).toBeUndefined();
});

test("strips real exec headers while preserving all stdout/stderr bytes", () => {
	const stdout = '  hello\n{"count":2}\n\nstderr:\nwarning here\nOutput:\nCommand: user data\n';
	const raw = formatUnifiedExecResult(execution(stdout), "printf 'hello\\n'\nprintf 'world'");
	expect(formatOutput(raw)).toEqual({ text: stdout, notices: [], changed: true });
	expect(formatOutput(wrap(raw, execution(stdout)))).toEqual({ text: stdout, notices: [], changed: true });
});

test("leaves unrecognized and incomplete exec-like output alone", () => {
	for (const raw of [
		"Command: documentation\nOutput:\nexample",
		"Wall time: 1 seconds\nOutput:",
		"Chunk ID: sample\nWall time: soon\nOutput:\nhello",
		"Wall time: 1 seconds\nNew status: unknown\nOutput:\nhello",
		"ordinary\nProcess exited with code 1\n",
	]) {
		expect(formatOutput(raw)).toEqual({ text: raw, notices: [], changed: false });
	}
});

test("de-duplicates nonzero exit and timeout notices from text and details", () => {
	const result = execution("failed\n", { exit_code: 7, timed_out: true });
	const parsed = formatOutput(wrap(formatUnifiedExecResult(result), result, true));
	expect(parsed.text).toBe("failed\n");
	expect(parsed.notices).toEqual([
		{ text: "Tool error", level: "error" },
		{ text: "Process exited with code 7", level: "error" },
		{ text: "Process timed out", level: "error" },
	]);
});

test("running sessions retain process ID and TTY notices", () => {
	const result = execution("waiting", { exit_code: undefined, process_id: 42, stdin_open: true });
	const parsed = formatOutput(wrap(formatUnifiedExecResult(result), result));
	expect(parsed.text).toBe("waiting");
	expect(parsed.notices).toEqual([
		{ text: "Process running with process ID 42", level: "info" },
		{ text: "TTY: yes", level: "info" },
	]);
});

test("truncation, paths, cancellation, warnings survive as classified notices", () => {
	const parsed = formatOutput(
		wrap("long\n".repeat(20), {
			cancelled: true,
			warnings: ["careful", "careful"],
			truncated: true,
			output_truncated: true,
			fullOutputPath: "/tmp/full.txt",
			full_output_path: "/tmp/full.txt",
		}),
	);
	expect(parsed.notices).toEqual([
		{ text: "Process cancelled", level: "warning" },
		{ text: "warning: careful", level: "warning" },
		{ text: "Output truncated", level: "warning" },
		{ text: "Full output: /tmp/full.txt", level: "info" },
	]);
});

test("recursively unwraps envelopes and text block arrays and omits rendering metadata only", () => {
	const nested = wrap(
		JSON.stringify([
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		]),
		{ highlightedRows: ["ansi"], highlightedSections: [], hashlineTag: "ABC" },
	);
	expect(formatOutput(nested).text).toBe("one\ntwo");
	expect(formatOutput(wrap("data", { extra: { count: 2 }, highlightedRows: [] })).text).toContain('"count": 2');
	expect(formatOutput(wrap("data", [1, 2])).text).toContain('"details": [');
});

test("handles labels and JSONL without reformatting ordinary text or arbitrary JSON lines", () => {
	const raw = `Files:\n${wrap("one")}\nSecond: ${wrap("two")}\n{"count":2}\n`;
	expect(formatOutput(raw).text).toBe('Files:\none\nSecond: two\n{"count":2}\n');
});

test("unknown structured data and block fields are retained", () => {
	for (const value of [
		{ count: 2 },
		{ content: [{ type: "text", text: "one" }], extra: 42 },
		[{ type: "resource", uri: "sample://one" }],
		[{ type: "text", text: "one", extra: 42 }],
	]) {
		const formatted = formatOutput(JSON.stringify(value)).text;
		expect(formatted).toContain(
			Array.isArray(value) ? '"type"' : Object.hasOwn(value, "count") ? '"count": 2' : '"extra": 42',
		);
	}
});

test("images become placeholders without base64 and retain unknown image fields", () => {
	const result = formatOutput(
		JSON.stringify({ content: [{ type: "image", data: "base64-secret", mimeType: "image/png", caption: "diagram" }] }),
	);
	expect(result.text).toContain("[Image output: image/png]");
	expect(result.text).toContain('"caption": "diagram"');
	expect(result.text).not.toContain("base64-secret");
});

test("empty and malformed data remain safe; depth and size limits retain content", () => {
	expect(formatOutput("")).toEqual({ text: "", notices: [], changed: false });
	expect(formatOutput('{"content":')).toEqual({ text: '{"content":', notices: [], changed: false });
	expect(formatOutput('{"content":[]}').text).toBe("");
	let nested = "retained";
	for (let i = 0; i < 10; i++) nested = wrap(nested);
	expect(formatOutput(nested).text).toContain("retained");
	const large = "x".repeat(1_000_001);
	expect(formatOutput(large)).toEqual({ text: large, notices: [], changed: false });
});

test("truncated exec wrappers strip boilerplate and retain visible truncation/path notices", () => {
	const stdout = "start…12 tokens truncated…end\n[Full output: /tmp/output.txt (read with offset/limit)]";
	const raw = `Total output lines: 90\n\n${formatUnifiedExecResult(execution(stdout))}`;
	expect(formatOutput(raw)).toEqual({
		text: stdout,
		changed: true,
		notices: [
			{ text: "Output truncated", level: "warning" },
			{ text: "Full output: /tmp/output.txt", level: "info" },
		],
	});
});

test("omits apply-patch rendering rows without silently dropping meaningful patch data", () => {
	const raw = wrap("M sample.ts", {
		highlightedDiffRows: [{ highlightedContent: "noise" }],
		diff: "actual diff",
		changes: [{ path: "sample.ts" }],
	});
	const output = formatOutput(raw).text;
	expect(output).not.toContain("highlightedDiffRows");
	expect(output).not.toContain("noise");
	expect(output).toContain("actual diff");
	expect(output).toContain('"changes"');
});

test("arbitrary JSON errors and malformed envelopes remain data, not failure notices", () => {
	for (const value of [{ error: "example" }, { details: { exit_code: 1 } }, { content: [], isError: "unknown" }]) {
		expect(formatOutput(JSON.stringify(value))).toEqual({
			text: JSON.stringify(value, null, 2),
			notices: [],
			changed: true,
		});
	}
});

test("session errors are de-duplicated and unknown detail keys are not lost", () => {
	const result = execution("failed", { session_error: "session unavailable" });
	expect(formatOutput(wrap(formatUnifiedExecResult(result), result)).notices).toEqual([
		{ text: "Session error: session unavailable", level: "error" },
	]);
	expect(formatOutput('{"content":[],"details":{"__proto__":{"retained":true}}}').text).toContain('"__proto__"');
});
