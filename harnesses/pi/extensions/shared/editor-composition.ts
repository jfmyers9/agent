import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";

export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

export type EditorUi = {
	getEditorComponent?: () => EditorFactory | undefined;
	setEditorComponent: (factory: EditorFactory | undefined) => void;
};

export type EditorLayer = (factory: EditorFactory | undefined) => EditorFactory;

type ComposedEditorFactory = EditorFactory & {
	[COMPOSED_FACTORY_BASE]?: EditorFactory | undefined;
	[COMPOSED_FACTORY_STATE]?: EditorCompositionState;
};

type EditorCompositionState = {
	baseFactory: EditorFactory | undefined;
	layers: Map<symbol, EditorLayer>;
	setEditorComponent: EditorUi["setEditorComponent"];
};

type ComposableEditorUi = EditorUi & {
	[EDITOR_COMPOSITION_STATE]?: EditorCompositionState;
};

const EDITOR_COMPOSITION_STATE = Symbol.for("agents.editorComposition.state");
const COMPOSED_FACTORY_BASE = Symbol.for("agents.editorComposition.composedBase");
const COMPOSED_FACTORY_STATE = Symbol.for("agents.editorComposition.composedState");

function unwrapFactory(factory: EditorFactory | undefined, state: EditorCompositionState): EditorFactory | undefined {
	const composed = factory as ComposedEditorFactory | undefined;
	return composed?.[COMPOSED_FACTORY_STATE] === state ? composed[COMPOSED_FACTORY_BASE] : factory;
}

function buildComposedFactory(state: EditorCompositionState): EditorFactory | undefined {
	let factory = state.baseFactory;
	for (const layer of state.layers.values()) {
		factory = layer(factory);
	}
	if (!factory) return undefined;
	const composed = factory as ComposedEditorFactory;
	composed[COMPOSED_FACTORY_BASE] = state.baseFactory;
	composed[COMPOSED_FACTORY_STATE] = state;
	return factory;
}

function applyComposition(state: EditorCompositionState): void {
	state.setEditorComponent(buildComposedFactory(state));
}

export function installEditorLayer(ui: EditorUi, id: symbol, layer: EditorLayer): void {
	if (typeof ui.getEditorComponent !== "function") return;

	const composableUi = ui as ComposableEditorUi;
	let state = composableUi[EDITOR_COMPOSITION_STATE];
	if (!state) {
		state = {
			baseFactory: ui.getEditorComponent(),
			layers: new Map(),
			setEditorComponent: ui.setEditorComponent.bind(ui),
		};
		composableUi[EDITOR_COMPOSITION_STATE] = state;

		ui.setEditorComponent = (factory) => {
			const activeState = composableUi[EDITOR_COMPOSITION_STATE];
			if (!activeState) return;
			activeState.baseFactory = unwrapFactory(factory, activeState);
			applyComposition(activeState);
		};
	}

	state.layers.set(id, layer);
	applyComposition(state);
}
