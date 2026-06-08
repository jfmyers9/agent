import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ASK_TOOL_DESCRIPTION,
	invalidPayloadResponse,
	nonInteractiveResponse,
	renderAskToolCall,
	renderAskToolResult,
	successfulResponse,
	validateParams,
} from "./ask-tool-helpers";
import { updateMuxAskState } from "./mux-state";
import { AskParamsSchema } from "./schema";
import type { AskParams } from "./types";
import { runAskFlow } from "./ui/controller";

export function registerAskTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		renderShell: "self",
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet:
			"Clarify ambiguous or preference-sensitive decisions with a short interactive interview before proceeding",
		parameters: AskParamsSchema,
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExecuteContext,
		) => executeAskTool(pi, toolCallId, params as AskParams, signal, onUpdate, ctx),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

interface ExecuteContext extends Pick<ExtensionContext, "cwd" | "hasUI"> {}

async function executeAskTool(
	pi: ExtensionAPI,
	_toolCallId: string,
	params: AskParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExecuteContext,
) {
	const validation = validateParams(params);
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	if (!ctx.hasUI) {
		return nonInteractiveResponse(validation.state);
	}
	pi.events.emit("ask:waiting:start", undefined);
	updateMuxAskState({ activity: "Waiting", asking: true }, ctx.cwd);
	try {
		const result = await runAskFlow(ctx as never, params);
		return successfulResponse(result);
	} finally {
		updateMuxAskState({ activity: "Working…", asking: false }, ctx.cwd);
		pi.events.emit("ask:waiting:end", undefined);
	}
}
