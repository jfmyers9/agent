import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

type WidgetContent = undefined | string[] | ((tui: TUI, theme: Theme) => Component & { dispose?: () => void });

type WidgetOptions = { placement?: "aboveEditor" | "belowEditor" };

interface OrderedWidgetUi {
	setWidget(key: string, content: WidgetContent, options?: WidgetOptions): void;
}

type OrderedWidgetTarget = ExtensionContext | OrderedWidgetUi;

interface OrderedWidgetEntry {
	content: Exclude<WidgetContent, undefined>;
	options: WidgetOptions;
}

interface OrderedWidgetState {
	entries: Map<string, OrderedWidgetEntry>;
	applying: boolean;
}

const orderedAboveEditorKeys = ["project-tasks", "background-terminals", "prompt-storage-stash"];
const states = new WeakMap<object, OrderedWidgetState>();

export function setOrderedAboveEditorWidget(target: OrderedWidgetTarget, key: string, content: WidgetContent): void {
	const ui = "ui" in target ? (target.ui as unknown as OrderedWidgetUi) : target;
	const state = stateFor(ui);
	const hadEntry = state.entries.has(key);
	if (content === undefined) {
		state.entries.delete(key);
		ui.setWidget(key, undefined);
		return;
	}

	state.entries.set(key, { content, options: { placement: "aboveEditor" } });
	if (!hadEntry && state.entries.size === 1) {
		ui.setWidget(key, content, { placement: "aboveEditor" });
	} else {
		applyOrderedWidgets(ui, state);
	}
}

function stateFor(ui: OrderedWidgetUi): OrderedWidgetState {
	const existing = states.get(ui);
	if (existing) return existing;
	const state: OrderedWidgetState = { entries: new Map(), applying: false };
	states.set(ui, state);
	return state;
}

function applyOrderedWidgets(ui: OrderedWidgetUi, state: OrderedWidgetState): void {
	if (state.applying) return;
	state.applying = true;
	try {
		for (const key of orderedActiveKeys(state)) {
			ui.setWidget(key, undefined);
		}
		for (const key of orderedActiveKeys(state)) {
			const entry = state.entries.get(key)!;
			ui.setWidget(key, entry.content, entry.options);
		}
	} finally {
		state.applying = false;
	}
}

function orderedActiveKeys(state: OrderedWidgetState): string[] {
	return orderedAboveEditorKeys.filter((key) => state.entries.has(key));
}
