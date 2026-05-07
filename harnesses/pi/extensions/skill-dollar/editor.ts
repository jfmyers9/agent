import { CustomEditor, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { colorize } from "./highlight";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type EditorUi = {
	getEditorComponent?: () => EditorFactory | undefined;
	setEditorComponent: (factory: EditorFactory | undefined) => void;
};

type TransformableEditor = EditorComponent & {
	transformEditorLine?: (line: string) => string;
};

const WRAPPED_FACTORY = Symbol.for("skill-dollar.editorFactoryWrapped");

export function installEditorHighlight(ui: EditorUi, getSkillNames: () => Set<string>): void {
	if (typeof ui.getEditorComponent !== "function") return;
	const previous = ui.getEditorComponent();
	if (previous && (previous as unknown as Record<symbol, boolean>)[WRAPPED_FACTORY]) return;

	const wrapped: EditorFactory = (tui, theme, keybindings) => {
		const editor = (previous?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings)) as TransformableEditor;
		const previousTransform = editor.transformEditorLine?.bind(editor);
		editor.transformEditorLine = (line: string) =>
			colorize(previousTransform ? previousTransform(line) : line, getSkillNames());
		return editor;
	};
	(wrapped as unknown as Record<symbol, boolean>)[WRAPPED_FACTORY] = true;
	ui.setEditorComponent(wrapped);
}
