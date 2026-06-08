import { ELABORATED_SUMMARY } from "./constants";
import { isCustomOnlyAnswer } from "./state/answers";
import type { AskResult } from "./types";

export function formatResultLines(result: AskResult, options: { mode: "summary" | "render" }): string[] {
	const lines: string[] = [];

	for (const question of result.questions) {
		const answer = result.answers[question.id];
		if (!answer) {
			continue;
		}

		const answerLine = formatAnswerLine(question.label, answer, options.mode);
		if (answerLine) {
			lines.push(answerLine);
		}

		const questionNoteLine = formatQuestionNoteLine(question.label, answer.note, options.mode);
		if (questionNoteLine) {
			lines.push(questionNoteLine);
		}

		lines.push(...formatOptionNoteLines(question.label, answer, options.mode));
	}

	return lines;
}

function formatAnswerLine(
	questionLabel: string,
	answer: AskResult["answers"][string],
	mode: "summary" | "render",
): string | undefined {
	const answerText = answer.labels.join(", ");
	if (!answerText) {
		return;
	}
	if (mode === "summary") {
		return `${questionLabel}: ${answerText}`;
	}
	if (isCustomOnlyAnswer(answer)) {
		return `✓ ${questionLabel}: (wrote) ${answerText}`;
	}
	return `✓ ${questionLabel}: ${answerText}`;
}

function formatQuestionNoteLine(
	questionLabel: string,
	note: string | undefined,
	mode: "summary" | "render",
): string | undefined {
	if (!note) {
		return;
	}
	return mode === "summary" ? `${questionLabel} note: ${note}` : `  note: ${note}`;
}

export function formatElaborationLines(result: AskResult, _options: { mode: "summary" | "render" }): string[] {
	const items = result.elaboration?.items ?? [];
	const lines = items.map((item) => {
		if (item.target.kind === "question") {
			return `User asked to elaborate on question ${quote(item.question.prompt)} with note ${quote(item.note)}`;
		}
		if (!("option" in item)) {
			return `User asked to elaborate on question ${quote(item.question.prompt)} with note ${quote(item.note)}`;
		}
		return `User asked to elaborate on question ${quote(item.question.prompt)} option ${quote(item.option.label)} with note ${quote(item.note)}`;
	});

	return lines.length > 0 ? lines : [ELABORATED_SUMMARY];
}

function quote(value: string): string {
	return JSON.stringify(value);
}

function formatOptionNoteLines(
	questionLabel: string,
	answer: AskResult["answers"][string],
	mode: "summary" | "render",
): string[] {
	const lines: string[] = [];
	for (let index = 0; index < answer.values.length; index++) {
		const value = answer.values[index];
		const label = answer.labels[index] ?? value;
		const note = answer.optionNotes?.[value];
		if (!note) {
			continue;
		}
		lines.push(mode === "summary" ? `${questionLabel} / ${label} note: ${note}` : `  ${label} note: ${note}`);
	}
	return lines;
}
