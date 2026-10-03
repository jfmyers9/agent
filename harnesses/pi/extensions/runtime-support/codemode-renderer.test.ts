import { beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI, Theme, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { type Component, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { codeModeRenderers, installCodeModeRenderer, summarizeCall } from "./codemode-renderer";
import { formatOutput } from "./codemode-output";
import { formatUnifiedExecResult } from "../exec-command/tools/unified-exec-format";

let theme: Theme;
beforeEach(() => {
	theme = getThemeByName("dark")!;
});
const context = (expanded = false): ToolRenderContext => ({
	args: { code: 'text(await tools.read({path:"sample.ts"}));' },
	toolCallId: "script",
	invalidate() {},
	lastComponent: undefined,
	state: {},
	cwd: "/tmp",
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded,
	showImages: false,
	isError: false,
});
const render = (component: Component, width = 80) =>
	component
		.render(width)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.join("\n");
const envelope = JSON.stringify({
	content: [{ type: "text", text: "Readable file contents" }],
	details: { highlightedRows: ["noise"] },
});
const result = {
	content: [
		{ type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
		{ type: "text" as const, text: envelope },
	],
	details: { calls: [{ name: "read", args: '{"path":"sample.ts","limit":20}', status: "ok", durationMs: 25 }] },
};

test("unwraps text envelopes without rendering metadata", () => {
	expect(formatOutput(envelope).text).toBe("Readable file contents");
});

test("collapsed view hides script and metadata without changing tool results", () => {
	const before = JSON.stringify(result);
	const renderer = codeModeRenderers();
	const ctx = context();
	expect(render(renderer.renderCall!(ctx.args, theme, ctx)).trim()).toBe("");
	const output = render(renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx));
	expect(output).toContain("Read sample.ts");
	expect(output).toContain("Readable file contents");
	expect(output).not.toContain("highlightedRows");
	expect(output).not.toContain("Script completed");
	expect(JSON.stringify(result)).toBe(before);
});

test("expansion restores script, arguments and original output; switching slots is safe", () => {
	const native = {
		renderCall: (_args: unknown, _theme: Theme, ctx: ToolRenderContext) => {
			expect(ctx.lastComponent).toBeUndefined();
			return new Text(ctx.args.code, 0, 0);
		},
	};
	const renderer = codeModeRenderers(native);
	const ctx = context(true);
	ctx.lastComponent = new Text("Code Mode", 0, 0);
	expect(render(renderer.renderCall!(ctx.args, theme, ctx))).toContain("tools.read");
	const output = render(renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, ctx), 200);
	expect(output).toContain("Readable file contents");
	expect(output).toContain("Argument previews");
	expect(output).toContain("Original output");
	expect(output).toContain("highlightedRows");
});

test.each([
	12, 40, 80,
])("previews wrap safely and keep failures and full-output paths visible at %i columns", (width) => {
	const calls = Array.from({ length: 10 }, (_, i) => ({
		name: `read_${i}`,
		args: '{"path":"日本語/sample.ts"}',
		status: i ? "ok" : "error",
		error: i ? undefined : "Permission denied",
	}));
	const fixture = {
		content: [
			{ type: "text" as const, text: "line\n".repeat(50) },
			{ type: "text" as const, text: "Script error:\nfailed late" },
		],
		details: { calls, fullOutputPath: "/tmp/full.txt" },
	};
	const component = codeModeRenderers().renderResult!(fixture, { expanded: false, isPartial: false }, theme, {
		...context(),
		isError: true,
	});
	const lines = component.render(width);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	const output = lines.map(stripTerminalSequences).join("").replace(/\s+/g, " ");
	expect(output).toContain("Permission");
	expect(output).toContain("failed late");
	expect(output).toContain("/tmp/full.");
	expect(output).toContain(width < 20 ? "more" : "more lines");
	component.invalidate();
	expect(component.render(width)).toEqual(lines);
});

test("partial results, malformed arguments and missing details render without execution", () => {
	const renderer = codeModeRenderers();
	const fixture = { content: [], details: { calls: [{ name: "read", args: '{"path":', status: "running" }] } };
	expect(render(renderer.renderResult!(fixture, { expanded: false, isPartial: true }, theme, context()))).toContain(
		"… Read",
	);
	expect(() =>
		renderer.renderResult!(
			{ content: [], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			context(true),
		).render(0),
	).not.toThrow();
});

test("registers only a presentation resolver, chains other tools and tolerates older Pi", () => {
	let resolver: unknown;
	const pi = {
		registerToolRenderer(value: unknown) {
			resolver = value;
		},
	};
	installCodeModeRenderer(pi as unknown as ExtensionAPI);
	const resolve = resolver as (
		name: string,
		next: () => ReturnType<typeof codeModeRenderers>,
	) => ReturnType<typeof codeModeRenderers>;
	const native = codeModeRenderers();
	expect(resolve("read", () => native)).toBe(native);
	expect(resolve("codemode", () => native)).not.toBe(native);
	expect(() => installCodeModeRenderer({} as ExtensionAPI)).not.toThrow();
});

test("long successful-call output cannot hide nonzero exits, warnings, continuation or images", () => {
	const fixture = {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					content: [{ type: "text", text: "line\n".repeat(30) }],
					details: { exit_code: 1, warnings: ["careful"], truncated: true, process_id: 42 },
				}),
			},
			{ type: "image" as const, mimeType: "image/png", data: "encoded-data" },
		],
		details: { calls: result.details.calls },
	};
	const output = render(
		codeModeRenderers().renderResult!(fixture, { expanded: false, isPartial: false }, theme, context()),
	);
	for (const notice of ["Process exited with code 1", "careful", "Output truncated", "1 image"])
		expect(output).toContain(notice);
	expect(output).not.toContain("encoded-data");
});

test("recovers truncated command strings without exposing JSON syntax", () => {
	const args = `${JSON.stringify({ cmd: `printf "hello"\\n${"command ".repeat(50)}`, yield_time_ms: 1000 }).slice(0, 197)}...`;
	const summary = summarizeCall({ name: "exec_command", args });
	expect(summary.label).toBe("Run");
	expect(summary.detail).toStartWith('printf "hello"');
	expect(summary.detail).not.toContain('{"cmd"');
	expect(summarizeCall({ name: "exec_command", args: '{"cmd":"unterminated\\' }).detail).toBe("unterminated");
	expect(summarizeCall({ name: "read", args: '{"path":"a\\u65' }).detail).toBe("a");
	expect(summarizeCall({ name: "search", args: '{"path":"src","pattern":"needle"}' }).detail).toBe("needle · src");
});

test("operation rows stay one line and activity folds get meaningful summaries", () => {
	const fixture = {
		content: [],
		details: {
			calls: [{ name: "exec_command", args: JSON.stringify({ cmd: `echo ${"wide ".repeat(100)}` }), status: "ok" }],
		},
	};
	const component = codeModeRenderers().renderResult!(fixture, { expanded: false, isPartial: false }, theme, context());
	const rows = component.render(40);
	expect(rows).toHaveLength(1);
	expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(40);
	expect(stripTerminalSequences(rows[0]!)).toEndWith("…");
	expect((component as Component & { getActivityLabel(): string }).getActivityLabel()).toContain("Run · echo");
	expect(render(component)).not.toContain("0.0s");
});

test("text-only shell output loses only transport headers and keeps failure notice ahead of preview", () => {
	const fixture = {
		content: [
			{
				type: "text" as const,
				text:
					"Command: test\nChunk ID: abc\nWall time: 0.1200 seconds\nProcess exited with code 2\nOutput:\n" +
					"line\n".repeat(40),
			},
		],
		details: { calls: result.details.calls },
	};
	const output = render(
		codeModeRenderers().renderResult!(fixture, { expanded: false, isPartial: false }, theme, context()),
	);
	expect(output).not.toContain("Chunk ID:");
	expect(output).not.toContain("Wall time:");
	expect(output).not.toContain("Command:");
	expect(output.indexOf("Process exited with code 2")).toBeLessThan(output.indexOf("line"));
});

test("printed Script error text is data, not a fabricated failure", () => {
	const fixture = {
		content: [{ type: "text" as const, text: 'source contains "Script error:" here' }],
		details: undefined,
	};
	const component = codeModeRenderers().renderResult!(fixture, { expanded: false, isPartial: false }, theme, context());
	expect(render(component)).toContain('source contains "Script error:" here');
	expect(render(component)).not.toContain("✗");
});

test("specific script failure is shown once instead of three duplicate errors", () => {
	const fixture = {
		content: [
			{ type: "text" as const, text: '{"content":[],"isError":true}' },
			{ type: "text" as const, text: "Script error:\nPermission denied" },
		],
		details: { calls: [{ name: "read", args: '{"path":"secret.txt"}', status: "error", error: "Permission denied" }] },
	};
	const component = codeModeRenderers().renderResult!(fixture, { expanded: false, isPartial: false }, theme, {
		...context(),
		isError: true,
	});
	const output = render(component);
	expect(output.match(/Permission denied/g)).toHaveLength(1);
	expect(output).not.toContain("Tool error");
});

test("cancellation and returned exit failure cannot present as success", () => {
	for (const status of ["Process cancelled", "Process exited with code 1"]) {
		const fixture = {
			content: [{ type: "text" as const, text: `Wall time: 0.1 seconds\n${status}\nOutput:\n` }],
			details: undefined,
		};
		const component = codeModeRenderers().renderResult!(
			fixture,
			{ expanded: false, isPartial: false },
			theme,
			context(),
		);
		expect(render(component)).not.toContain("✓");
		expect(render(component)).toContain(status);
	}
});

test.each([false, true])("failed shell envelopes render once with visible diagnostics (uncaught: %s)", (uncaught) => {
	const diagnostic = "Intentional demo failure; no files changed.";
	const stdout = Array.from(
		{ length: 10 },
		(_, i) => `demo output ${String(i + 1).padStart(2, "0")} — checking folded failure output`,
	);
	const cmd =
		"printf 'demo output %s\\n' {01..10}; printf 'Intentional demo failure; no files changed.\\n' >&2; exit 1";
	const transportError = formatUnifiedExecResult(
		{
			chunk_id: "demo-failure",
			wall_time_seconds: 0.012,
			exit_code: 1,
			original_token_count: 180,
			output: `${stdout.join("\n")}\n\nstderr:\n${diagnostic}`,
		},
		cmd,
	);
	// Pi stores only a shortened nested error, but the caught/uncaught printed error is complete.
	expect(transportError.length).toBeGreaterThan(500);
	const raw = `${uncaught ? "Script error:" : "Expected demo failure:"}\nError: ${transportError}`;
	const fixture = {
		content: [{ type: "text" as const, text: raw }],
		details: {
			calls: [
				{
					name: "exec_command",
					args: JSON.stringify({ cmd }),
					status: "error",
					error: `${transportError.slice(0, 497)}...`,
				},
			],
		},
	};
	const before = JSON.stringify(fixture);
	const renderer = codeModeRenderers();
	const ctx = { ...context(), isError: uncaught };
	const collapsed = render(renderer.renderResult!(fixture, { expanded: false, isPartial: false }, theme, ctx), 120);
	for (const wrapper of ["Command:", "Chunk ID:", "Wall time:", "Output:", "Original token count:"])
		expect(collapsed).not.toContain(wrapper);
	expect(collapsed.match(/Process exited with code 1/g)).toHaveLength(1);
	expect(collapsed.split("\n").filter((line) => line.endsWith(diagnostic))).toHaveLength(1);
	for (const line of stdout.slice(0, 2)) expect(collapsed.split(line)).toHaveLength(2);
	expect(collapsed).toContain("more lines");
	expect(collapsed).toContain("✗");
	expect(collapsed).not.toContain("✓");
	const expanded = render(
		renderer.renderResult!(fixture, { expanded: true, isPartial: false }, theme, { ...ctx, expanded: true }),
		2000,
	);
	expect(expanded).toContain("Original output");
	// Ignore the renderer's indentation only; expansion must retain every raw line in order.
	expect(
		expanded
			.split("\n")
			.map((line) => line.replace(/^ {2}/, ""))
			.join("\n"),
	).toContain(raw);
	expect(JSON.stringify(fixture)).toBe(before);
});
