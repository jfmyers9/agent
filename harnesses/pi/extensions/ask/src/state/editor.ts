import type { AskState } from "../types";
import {
	getAnswer,
	getCurrentOption,
	getCurrentQuestion,
	getOptionNote,
	getQuestionNote,
	isSubmitTab,
} from "./selectors";
import { enterInputMode, saveCustomAnswer, saveNote, submitCustomAnswer } from "./transitions";
import { isEditingView } from "./view";

export function getEditorDraft(state: AskState): string {
	if (state.view.kind === "input") {
		return getAnswer(state, state.view.questionId)?.customText ?? "";
	}
	if (state.view.kind === "note") {
		if (state.view.optionValue) {
			return getOptionNote(state, state.view.questionId, state.view.optionValue) ?? "";
		}
		return getQuestionNote(state, state.view.questionId) ?? "";
	}
	return "";
}

export function saveEditorDraft(state: AskState, text: string): AskState {
	if (state.view.kind === "input") {
		return saveCustomAnswer(state, text);
	}
	if (state.view.kind === "note") {
		return saveNote(state, text);
	}
	return state;
}

export function submitEditorDraft(state: AskState, text: string): AskState {
	if (state.view.kind === "input") {
		return submitCustomAnswer(state, text);
	}
	if (state.view.kind === "note") {
		return saveNote(state, text);
	}
	return state;
}

export function syncStateToSelection(state: AskState): AskState {
	if (isEditingView(state) || isSubmitTab(state)) {
		return state;
	}

	const question = getCurrentQuestion(state);
	const option = getCurrentOption(state);
	if (!(question && option?.isCustomOption)) {
		return state;
	}

	return enterInputMode(state, question.id);
}
