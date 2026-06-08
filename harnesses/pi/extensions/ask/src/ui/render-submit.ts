import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AskState } from "../types";
import { UI_TEXT } from "./constants";
import { mergeColumns, pushSavedNote, pushWrappedText } from "./render-helpers";
import type { Theme } from "./render-types";
import { buildReviewScreenModel } from "./view-models/review";

export function renderSubmitScreen(lines: string[], state: AskState, theme: Theme, width: number) {
	const model = buildReviewScreenModel(state, width);
	if (model.layout === "wide") {
		const rightWidth = Math.max(1, width - model.actionColumnWidth - 2);
		const reviewLines = renderSubmitReviewLines(model, theme, rightWidth);
		const actionLines = renderSubmitActions(model, theme, model.actionColumnWidth);
		for (const line of mergeColumns(actionLines, reviewLines, model.actionColumnWidth, width)) {
			lines.push(line);
		}
		return;
	}

	const reviewLines = renderSubmitReviewLines(model, theme, width);
	const actionLines = renderSubmitActions(model, theme, width);
	lines.push(...reviewLines);
	lines.push("");
	lines.push(...actionLines);
}

function renderSubmitReviewLines(
	model: ReturnType<typeof buildReviewScreenModel>,
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];
	pushWrappedText(lines, UI_TEXT.reviewTitle, width, theme, "accent", " ", " ");
	lines.push("");

	for (const [index, question] of model.questions.entries()) {
		renderReviewQuestion(lines, question, theme, width);
		if (index < model.questions.length - 1) {
			lines.push("");
		}
	}

	return lines;
}

function renderReviewQuestion(
	lines: string[],
	question: ReturnType<typeof buildReviewScreenModel>["questions"][number],
	theme: Theme,
	width: number,
) {
	pushWrappedText(lines, question.label, width, theme, "text", " ", " ");
	if (question.unanswered) {
		lines.push(truncateToWidth(`   ${theme.fg("dim", UI_TEXT.unanswered)}`, width));
		return;
	}

	if (question.note) {
		pushSavedNote({
			lines,
			note: question.note,
			width,
			theme,
			indent: "     ",
		});
	}

	for (const selection of question.selections ?? []) {
		pushWrappedText(lines, `→ ${selection.label}`, width, theme, "success", "   ", "     ");
		if (selection.note) {
			pushSavedNote({
				lines,
				note: selection.note,
				width,
				theme,
				indent: "     ",
			});
		}
	}

	if (question.answerText) {
		pushWrappedText(
			lines,
			`→ ${question.answerText}`,
			width,
			theme,
			question.isCustomOnly ? "text" : "success",
			"   ",
			"     ",
		);
	}

	for (const optionNote of question.extraOptionNotes ?? []) {
		pushSavedNote({
			lines,
			note: optionNote.note,
			width,
			theme,
			indent: "     ",
			label: optionNote.label,
		});
	}
}

function renderSubmitActions(model: ReturnType<typeof buildReviewScreenModel>, theme: Theme, width: number): string[] {
	const lines: string[] = [];
	for (const [index, action] of model.actions.entries()) {
		const prefix = action.selected ? "❯ " : "  ";
		pushWrappedText(
			lines,
			`${index + 1}. ${action.label}`,
			width,
			theme,
			action.selected ? "accent" : "text",
			prefix,
			prefix,
		);
	}
	return lines;
}
