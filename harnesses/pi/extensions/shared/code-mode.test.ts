import { expect, test } from "bun:test";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerCodeModeTool } from "./code-mode.ts";

function register(result: any, mapResult?: (result: any) => any) {
	let registered!: ToolDefinition;
	registerCodeModeTool(
		{
			registerTool: (tool) => {
				registered = tool;
			},
		},
		{
			name: "example",
			label: "Example",
			description: "Example",
			parameters: Type.Object({}),
			execute: async () => result,
		},
		{ mapResult },
	);
	return {
		tool: registered,
		run: () => registered.execute("call", {}, new AbortController().signal, undefined, {} as ExtensionToolContext),
	};
}

test("native codemode receives content and details with one direct tool registration", async () => {
	const result = { content: [{ type: "text", text: "file content" }], details: { rows: [] } };
	const fixture = register(result);
	expect(fixture.tool.outputSchema).toBeDefined();
	expect(fixture.tool.exposure).toBeUndefined();
	expect(await fixture.run()).toEqual({ ...result, structuredContent: result });
});

test("result mapping bounds output before native structured content is exposed", async () => {
	const fixture = register({ content: [{ type: "text", text: "large output" }], details: {} }, (result) => ({
		...result,
		content: [{ type: "text", text: "bounded output" }],
	}));
	const result = await fixture.run();
	expect(result.structuredContent).toEqual({ content: [{ type: "text", text: "bounded output" }], details: {} });
});

for (const failure of [
	{ isError: true },
	{ details: { error: true } },
	{ details: { exit_code: 1 } },
	{ details: { timed_out: true } },
	{ details: { cancelled: true } },
	{ details: { session_error: "unavailable" } },
]) {
	test(`native codemode rejects failed results: ${JSON.stringify(failure)}`, async () => {
		const fixture = register({ content: [{ type: "text", text: "failure" }], details: {}, ...failure });
		const result = await fixture.run();
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "failure" }]);
	});
}
