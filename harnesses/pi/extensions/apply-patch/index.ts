import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildHighlightedDiffRows, type DiffRenderRow, EditDiffView, type RenderTheme } from "../fileops/diff-render";
import { textComponent } from "../shared/tui";
import { type ApplyPatchResult, runLocalApplyPatch } from "./backend.ts";

const APPLY_PATCH = "apply_patch";
const applyPatchSchema = Type.Object({
	input: Type.String({ description: "The full apply_patch payload in Codex apply_patch format." }),
});

type ModelLike = { id?: string; provider?: string };
type ApplyPatchToolDetails = {
	diff?: string;
	changes?: ApplyPatchResult["changes"];
	filesChanged?: number;
	highlightedDiffRows?: DiffRenderRow[];
	error?: boolean;
	message?: string;
};

type ApplyPatchToolResult = {
	content: [{ type: "text"; text: string }];
	details: ApplyPatchToolDetails;
};

function isGptModel(model: ModelLike | undefined): boolean {
	const id = model?.id?.toLowerCase() ?? "";
	const provider = model?.provider?.toLowerCase() ?? "";
	return id.startsWith("gpt-") || (provider.includes("openai") && id.includes("gpt"));
}

async function formatResult(result: ApplyPatchResult): Promise<ApplyPatchToolResult> {
	const highlightedDiffRows = result.diff ? await buildHighlightedDiffRows(result.diff) : undefined;
	return {
		content: [{ type: "text", text: result.stdout || "(no changes)" }],
		details: { diff: result.diff, changes: result.changes, filesChanged: result.changes.length, highlightedDiffRows },
	};
}

function errorResult(error: unknown): ApplyPatchToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: true, message } };
}

function isSameTools(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function renderApplyPatchResult(
	result: ApplyPatchToolResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
) {
	if (options.isPartial) return textComponent(theme.fg("warning", "Applying patch..."));
	const text = result.content.find((part) => part.type === "text")?.text ?? "";
	if (result.details.error || text.startsWith("Error:")) return textComponent(theme.fg("error", text));
	if (!result.details.diff) return textComponent(theme.fg("toolTitle", `apply_patch: ${text}`));
	return new EditDiffView(
		result.details.diff,
		result.details.highlightedDiffRows,
		options.expanded ?? false,
		theme,
		(filePath, firstChangedLine, renderTheme) => {
			const line = firstChangedLine === undefined ? "" : `:${firstChangedLine}`;
			return `${renderTheme.fg("toolTitle", renderTheme.bold("Patch:"))} ${renderTheme.fg("accent", `${filePath}${line}`)}`;
		},
	);
}

function applyGptToolPolicy(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "model"> | undefined,
	state: { removed: Set<string>; activated: boolean },
): void {
	const active = pi.getActiveTools();
	const gpt = isGptModel(ctx?.model);
	let next = active;

	if (gpt) {
		next = active.filter((tool) => {
			if (tool === "edit" || tool === "write") {
				state.removed.add(tool);
				return false;
			}
			return true;
		});
		if (!next.includes(APPLY_PATCH)) {
			next = [...next, APPLY_PATCH];
			state.activated = true;
		}
	} else {
		next = active.filter((tool) => tool !== APPLY_PATCH);
		state.activated = false;
		for (const tool of state.removed) {
			if (!next.includes(tool)) next = [...next, tool];
		}
		state.removed.clear();
	}

	if (!isSameTools(active, next)) pi.setActiveTools(next);
}

export default function applyPatchExtension(pi: ExtensionAPI) {
	const policyState = { removed: new Set<string>(), activated: false };

	pi.registerTool({
		name: APPLY_PATCH,
		label: APPLY_PATCH,
		description:
			"Edit files using Codex apply_patch format. Use *** Update File for context-based edits, *** Add File, *** Delete File, *** Move File, or *** Replace All In File as appropriate.",
		promptSnippet: "Edit files with Codex's apply_patch format",
		promptGuidelines: [
			"Use apply_patch for file edits when it is available. Do not wrap the patch in shell commands or use write/edit instead.",
			"apply_patch payloads must start with *** Begin Patch and end with *** End Patch.",
		],
		parameters: applyPatchSchema,
		renderShell: "self",
		renderCall() {
			return textComponent("apply_patch");
		},
		renderResult(result, options, theme) {
			return renderApplyPatchResult(result as ApplyPatchToolResult, options, theme as unknown as RenderTheme);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				return await formatResult(await runLocalApplyPatch(ctx.cwd, params.input, { signal }));
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	const refresh = (_event?: unknown, ctx?: ExtensionContext) => applyGptToolPolicy(pi, ctx, policyState);
	pi.on("session_start", refresh);
	pi.on("session_tree", refresh);
	pi.on("model_select", refresh);
	pi.on("before_agent_start", refresh);
	pi.on("tool_call", (event, ctx) => {
		if (isGptModel(ctx.model) && (event.toolName === "edit" || event.toolName === "write")) {
			return { block: true, reason: "GPT models use apply_patch for file edits." };
		}
	});
}
