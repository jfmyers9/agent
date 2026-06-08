import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { AskState } from "../types";

const DIGIT_PATTERN = /^[1-9]$/;

export type AskInputCommand =
	| { kind: "moveTab"; delta: 1 | -1 }
	| { kind: "moveOption"; delta: 1 | -1 }
	| { kind: "toggleMulti" }
	| { kind: "openQuestionNote" }
	| { kind: "openOptionNote" }
	| { kind: "confirm" }
	| { kind: "cancel" }
	| { kind: "dismiss" }
	| { kind: "numberShortcut"; digit: number }
	| { kind: "editMoveTab"; delta: 1 | -1 }
	| { kind: "editMoveOption"; delta: 1 | -1 }
	| { kind: "editClose" }
	| { kind: "delegateToEditor" }
	| { kind: "ignore" };

export function getInputCommand(state: AskState, data: string, editingText = ""): AskInputCommand {
	if (matchesKey(data, Key.ctrl("c"))) {
		return { kind: "dismiss" };
	}

	if (state.view.kind === "input" || state.view.kind === "note") {
		return getEditingInputCommand(data, editingText, state.view.kind === "input");
	}

	return getNavigationInputCommand(data);
}

export function formatKeybindingLabel(key: string): string {
	return key
		.split("+")
		.map((part) => {
			if (part.length <= 1) {
				return part.toUpperCase();
			}
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join("+");
}

function getEditingInputCommand(data: string, editingText: string, enableVimNavigation: boolean): AskInputCommand {
	if (matchesKey(data, Key.escape)) {
		return { kind: "editClose" };
	}
	if (editingText.length === 0) {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			return { kind: "editMoveTab", delta: 1 };
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			return { kind: "editMoveTab", delta: -1 };
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")) || (enableVimNavigation && data === "k")) {
			return { kind: "editMoveOption", delta: -1 };
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")) || (enableVimNavigation && data === "j")) {
			return { kind: "editMoveOption", delta: 1 };
		}
	}
	return { kind: "delegateToEditor" };
}

function getNavigationInputCommand(data: string): AskInputCommand {
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return { kind: "moveTab", delta: 1 };
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return { kind: "moveTab", delta: -1 };
	}
	if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")) || data === "k") {
		return { kind: "moveOption", delta: -1 };
	}
	if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")) || data === "j") {
		return { kind: "moveOption", delta: 1 };
	}
	if (matchesKey(data, Key.space)) {
		return { kind: "toggleMulti" };
	}
	if (matchesKey(data, Key.enter)) {
		return { kind: "confirm" };
	}
	if (matchesKey(data, Key.escape)) {
		return { kind: "cancel" };
	}
	if (isQuestionNoteShortcut(data)) {
		return { kind: "openQuestionNote" };
	}
	if (isOptionNoteShortcut(data)) {
		return { kind: "openOptionNote" };
	}

	const digit = parseDigit(data);
	return digit === null ? { kind: "ignore" } : { kind: "numberShortcut", digit };
}

function isOptionNoteShortcut(data: string): boolean {
	return data === "n";
}

function isQuestionNoteShortcut(data: string): boolean {
	return data === "N";
}

function parseDigit(data: string): number | null {
	return DIGIT_PATTERN.test(data) ? Number(data) : null;
}
