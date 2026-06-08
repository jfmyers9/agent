import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme } from "@earendil-works/pi-tui";
import { defineExtensionTui } from "../../../shared/tui";
import { createInitialState } from "../state/create";
import { getEditorDraft, saveEditorDraft, submitEditorDraft, syncStateToSelection } from "../state/editor";
import { toAskResult } from "../state/result";
import { getCurrentOption, getCurrentQuestion, isSubmitTab } from "../state/selectors";
import {
	applyNumberShortcut,
	cancelFlow,
	confirmCurrentSelection,
	dismissFlow,
	enterOptionNoteMode,
	enterQuestionNoteMode,
	moveOption,
	moveTab,
	toggleCurrentMultiOption,
} from "../state/transitions";
import { isEditingView } from "../state/view";
import type { AskParams, AskResult, AskState } from "../types";
import { createAskAutocompleteProvider } from "./autocomplete";
import type { AskInputCommand } from "./input";
import { getInputCommand } from "./input";
import { renderAskScreen } from "./render";

type CustomCallback = Parameters<ExtensionContext["ui"]["custom"]>[0];
type CustomCallbackArgs = CustomCallback extends (...args: infer T) => unknown ? T : never;
type Tui = CustomCallbackArgs[0];
type Theme = CustomCallbackArgs[1];
type Keybindings = CustomCallbackArgs[2];
type Done = (result: AskResult) => void;
type AskFlowParams = AskParams & Pick<ExtensionContext, "cwd">;

const askTui = defineExtensionTui({ id: "ask" });

interface AskFlowController {
	done: Done;
	editor: Editor;
	state: AskState;
	suppressAutoInputForSelection: boolean;
	theme: Theme;
	tui: Tui;
}

export function runAskFlow(ctx: ExtensionContext, params: AskParams): Promise<AskResult> {
	return askTui.bind(ctx).overlays.openComponent<AskResult>(
		(tui, theme, keybindings, done) =>
			createAskFlowController([tui as Tui, theme as Theme, keybindings as Keybindings, done], {
				...params,
				cwd: ctx.cwd,
			}),
		{ overlay: false },
	);
}

function createAskFlowController(
	[tui, theme, _keybindings, done]: [Tui, Theme, Keybindings, (result: AskResult) => void],
	params: AskFlowParams,
) {
	const controller: AskFlowController = {
		done,
		editor: createEditor(tui, theme, params.cwd),
		state: createInitialState(params),
		suppressAutoInputForSelection: false,
		theme,
		tui,
	};

	controller.editor.onSubmit = (value) => submitEditor(controller, value);
	syncSelection(controller);

	return {
		render: (width: number) => renderController(controller, width),
		invalidate() {
			// The editor manages its own async autocomplete redraws.
		},
		handleInput(data: string) {
			handleControllerInput(controller, data);
		},
	};
}

function renderController(controller: AskFlowController, width: number): string[] {
	return renderAskScreen({
		editor: controller.editor,
		state: controller.state,
		theme: controller.theme,
		width,
	});
}

function handleControllerInput(controller: AskFlowController, data: string) {
	const command = getInputCommand(
		controller.state,
		data,
		isEditingView(controller.state) ? controller.editor.getText() : "",
	);
	if (isEditingView(controller.state)) {
		handleEditingCommand(controller, command, data);
		return;
	}
	handleNavigationCommand(controller, command);
}

function handleEditingCommand(controller: AskFlowController, command: AskInputCommand, data: string) {
	if (command.kind === "dismiss") {
		commitState(controller, dismissFlow(controller.state), { finish: true });
		return;
	}
	if (command.kind === "editMoveTab") {
		commitSavedEditorNavigation(controller, moveTab, command.delta);
		return;
	}
	if (command.kind === "editMoveOption") {
		commitSavedEditorNavigation(controller, moveOption, command.delta);
		return;
	}
	if (command.kind === "editClose") {
		closeEditor(controller);
		return;
	}
	if (command.kind === "delegateToEditor") {
		controller.editor.handleInput(data);
		refresh(controller);
	}
}

function handleNavigationCommand(controller: AskFlowController, command: AskInputCommand) {
	switch (command.kind) {
		case "moveTab":
			commitState(controller, moveTab(controller.state, command.delta));
			return;
		case "moveOption":
			commitState(controller, moveOption(controller.state, command.delta));
			return;
		case "toggleMulti":
			handleToggleCurrentOption(controller);
			return;
		case "openQuestionNote":
			openQuestionNote(controller);
			return;
		case "openOptionNote":
			openOptionNote(controller);
			return;
		case "confirm":
			commitState(controller, confirmCurrentSelection(controller.state), {
				finish: true,
			});
			return;
		case "cancel":
			commitState(controller, cancelFlow(controller.state), { finish: true });
			return;
		case "numberShortcut":
			commitState(controller, applyNumberShortcut(controller.state, command.digit));
			return;
		case "dismiss":
			commitState(controller, dismissFlow(controller.state), { finish: true });
			return;
		case "ignore":
		case "editMoveTab":
		case "editMoveOption":
		case "editClose":
		case "delegateToEditor":
			return;
		default:
			return;
	}
}

function handleToggleCurrentOption(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question) {
		return;
	}
	commitState(controller, toggleCurrentMultiOption(controller.state));
}

function openQuestionNote(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	if (!question || isSubmitTab(controller.state)) {
		return;
	}
	commitState(controller, enterQuestionNoteMode(controller.state, question.id), {
		syncSelection: false,
	});
}

function openOptionNote(controller: AskFlowController) {
	const question = getCurrentQuestion(controller.state);
	const option = getCurrentOption(controller.state);
	if (!(question && option) || option.isCustomOption || isSubmitTab(controller.state)) {
		return;
	}
	commitState(controller, enterOptionNoteMode(controller.state, question.id, option.value), { syncSelection: false });
}

function commitState(
	controller: AskFlowController,
	nextState: AskState,
	options: { finish?: boolean; syncSelection?: boolean } = {},
) {
	controller.suppressAutoInputForSelection = false;
	controller.state = nextState;
	if (options.syncSelection !== false) {
		syncSelection(controller);
	}
	hydrateEditor(controller);
	refresh(controller);
	if (options.finish) {
		maybeFinish(controller);
	}
}

function submitEditor(controller: AskFlowController, value: string) {
	controller.suppressAutoInputForSelection = false;
	controller.state = submitEditorDraft(controller.state, value);
	controller.editor.setText("");
	refresh(controller);
	maybeFinish(controller);
}

function commitSavedEditorNavigation(
	controller: AskFlowController,
	navigate: (state: AskState, delta: 1 | -1) => AskState,
	delta: 1 | -1,
) {
	commitState(controller, navigate(saveEditorState(controller), delta));
}

function closeEditor(controller: AskFlowController) {
	const nextState = saveEditorState(controller);
	controller.suppressAutoInputForSelection = nextState.view.kind !== "input";
	controller.state = nextState;
	refresh(controller);
}

function refresh(controller: AskFlowController) {
	controller.tui.requestRender();
}

function maybeFinish(controller: AskFlowController) {
	if (controller.state.completed) {
		controller.done(toAskResult(controller.state));
	}
}

function hydrateEditor(controller: AskFlowController) {
	controller.editor.setText(getEditorDraft(controller.state));
}

function syncSelection(controller: AskFlowController) {
	if (controller.suppressAutoInputForSelection) {
		return;
	}
	controller.state = syncStateToSelection(controller.state);
}

function saveEditorState(controller: AskFlowController): AskState {
	const text = controller.editor.getText();
	controller.editor.setText("");
	return saveEditorDraft(controller.state, text);
}

function createEditor(tui: Tui, theme: Theme, cwd: string) {
	const editor = new Editor(tui, createEditorTheme(theme));
	editor.setAutocompleteProvider(createAskAutocompleteProvider(cwd));
	return editor;
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			description: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("warning", text),
			scrollInfo: (text) => theme.fg("dim", text),
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
		},
	};
}
