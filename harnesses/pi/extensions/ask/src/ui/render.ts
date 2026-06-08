import { getCurrentQuestion, getRenderableOptions, isSubmitTab } from "../state/selectors";
import type { AskState } from "../types";
import { renderFrameFooter, renderFrameHeader } from "./render-frame";
import { renderQuestionScreen } from "./render-question";
import { renderSubmitScreen } from "./render-submit";
import type { QuestionRenderContext, Theme } from "./render-types";

export function renderAskScreen(args: {
	state: AskState;
	theme: Theme;
	width: number;
	editor: QuestionRenderContext["editor"];
}): string[] {
	const { state, theme, width, editor } = args;
	const lines: string[] = [];
	const question = getCurrentQuestion(state);
	const options = getRenderableOptions(question);

	renderFrameHeader({ lines, state, theme, width });

	if (isSubmitTab(state)) {
		renderSubmitScreen(lines, state, theme, width);
	} else if (question) {
		renderQuestionScreen({
			lines,
			state,
			question,
			options,
			theme,
			width,
			editor,
		});
	}

	renderFrameFooter({ lines, state, theme, width });
	return lines;
}
