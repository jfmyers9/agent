import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { textComponent } from "../../shared/tui";
import { renderResultText } from "./result";
import { createInitialState } from "./state/create";
import { collectValidationIssues } from "./state/normalize";
import { summarizeResult, toAskResult } from "./state/result";
import type { AskParams, AskQuestionInput, AskResult, AskValidationIssue } from "./types";
import { UI_DIMENSIONS } from "./ui/constants";

export const ASK_TOOL_DESCRIPTION =
	"Ask a short interactive clarification when user preference or missing requirements block a decision. Supports single, multi, and preview questions. Options need value+label; preview questions need preview on every option.";

export function validateParams(
	params: AskParams,
): { ok: true; state: ReturnType<typeof createInitialState> } | { ok: false; issues: AskValidationIssue[] } {
	const issues = collectValidationIssues(params);
	if (issues.length > 0) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		state: createInitialState(params),
	};
}

export function invalidPayloadResponse(params: AskParams, issues: AskValidationIssue[]) {
	return {
		content: [{ type: "text" as const, text: formatValidationError(issues) }],
		details: errorResultDetails(params, issues),
	};
}

export function nonInteractiveResponse(state: ReturnType<typeof createInitialState>) {
	return {
		content: [{ type: "text" as const, text: formatNonInteractiveMessage(state) }],
		details: {
			...toAskResult(state),
			cancelled: true,
		},
	};
}

export function successfulResponse(result: AskResult) {
	return {
		content: [{ type: "text" as const, text: summarizeResult(result) }],
		details: result,
	};
}

type ToolTheme = ExtensionContext["ui"]["theme"];

export function renderAskToolCall(args: unknown, theme: ToolTheme) {
	const params = args as AskParams;
	const labels = Array.isArray(params.questions)
		? params.questions.map((question: AskQuestionInput, index) => question.label || `Q${index + 1}`).join(", ")
		: "";
	let text = theme.fg("toolTitle", theme.bold("Ask User "));
	text += theme.fg("muted", `${params.questions?.length ?? 0} question(s)`);
	if (labels) {
		text += theme.fg("dim", ` (${truncateToWidth(labels, UI_DIMENSIONS.callLabelTruncateWidth)})`);
	}
	return textComponent(text);
}

export function renderAskToolResult(
	result: {
		content: Array<{ type?: string; text?: string }>;
		details?: AskResult;
	},
	_options: unknown,
	theme: ToolTheme,
	context?: { lastComponent?: unknown },
) {
	const textComponentInstance = context?.lastComponent instanceof Text ? context.lastComponent : textComponent("");
	const details = result.details;
	if (!details) {
		const text = result.content[0];
		textComponentInstance.setText(text?.type === "text" ? (text.text ?? "") : "");
		return textComponentInstance;
	}
	if (details.error) {
		textComponentInstance.setText(theme.fg("warning", "Invalid input"));
		return textComponentInstance;
	}
	if (details.cancelled) {
		textComponentInstance.setText(theme.fg("warning", "Cancelled"));
		return textComponentInstance;
	}
	textComponentInstance.setText(renderResultBlock(details, theme));
	return textComponentInstance;
}

function renderResultBlock(result: AskResult, theme: ToolTheme): string {
	const body = renderResultText(result).split("\n");
	const title = result.mode === "elaborate" ? "Ask User — Elaboration" : "Ask User";
	const lines = [theme.fg("toolTitle", theme.bold(title))];
	for (const [index, line] of body.entries()) {
		const prefix = index === body.length - 1 ? "  └ " : "  ├ ";
		lines.push(`${theme.fg("dim", prefix)}${line}`);
	}
	return lines.join("\n");
}

function errorResultDetails(params: AskParams, issues: AskValidationIssue[]): AskResult {
	return {
		title: params.title,
		cancelled: true,
		mode: "submit",
		questions: [],
		answers: {},
		error: {
			kind: "invalid_input",
			issues,
		},
	};
}

function formatValidationError(issues: AskValidationIssue[]): string {
	return ["Invalid ask_user payload:", ...issues.map((issue) => `- ${issue.path}: ${issue.message}`)].join("\n");
}

function formatNonInteractiveMessage(state: ReturnType<typeof createInitialState>): string {
	const lines = [
		"Needs user input: ask_user requires interactive UI.",
		"Run same tool call in interactive session, or ask user these questions manually:",
	];

	for (const [index, question] of state.questions.entries()) {
		lines.push(`${index + 1}. ${question.label}: ${question.prompt}`);
		for (const option of question.options) {
			lines.push(`   - ${option.label} [${option.value}]`);
		}
		lines.push("   - Type your own [custom]");
	}

	lines.push(
		"details.questions contains normalized pending questions. details.answers stays empty until user responds.",
	);
	return lines.join("\n");
}
