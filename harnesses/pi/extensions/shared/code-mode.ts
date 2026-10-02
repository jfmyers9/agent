import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

/** Preserve tool content and rendering metadata for native codemode callers. */
export function registerCodeModeTool<TParams extends TSchema, TDetails, TState = any>(
	pi: Pick<ExtensionAPI, "registerTool">,
	tool: ToolDefinition<TParams, TDetails, TState>,
	options: { mapResult?: (result: AgentToolResult<TDetails>) => AgentToolResult<TDetails> } = {},
): void {
	pi.registerTool({
		...tool,
		outputSchema: Type.Object({ content: Type.Array(Type.Any()), details: Type.Optional(Type.Any()) }),
		async execute(...args) {
			const raw = await tool.execute(...args);
			const result = options.mapResult ? options.mapResult(raw) : raw;
			const details = result.details as Record<string, unknown> | undefined;
			const failed =
				result.isError ||
				details?.error === true ||
				(typeof details?.exit_code === "number" && details.exit_code !== 0) ||
				details?.timed_out === true ||
				details?.cancelled === true ||
				typeof details?.session_error === "string";
			// Native codemode rejects error results without structured content, retaining the
			// original content and details for tool-result hooks and rendering.
			if (failed) return { ...result, isError: true, structuredContent: undefined };
			return {
				...result,
				structuredContent: { content: result.content, details: result.details } as unknown as JsonValue,
			};
		},
	});
}
