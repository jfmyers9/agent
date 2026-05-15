import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { type EditorFactory, type EditorUi, installEditorLayer } from "../shared/editor-composition";
import { colorize } from "./highlight";

type TransformableEditor = EditorComponent & {
	transformEditorLine?: (line: string) => string;
};

const EDITOR_LAYER_ID = Symbol.for("skillful.editorHighlightLayer");

function colorizeLines(lines: string[], getSkillNames: () => Set<string>): string[] {
	return lines.map((line) => colorize(line, getSkillNames()));
}

function wrapEditorFactory(previous: EditorFactory | undefined, getSkillNames: () => Set<string>): EditorFactory {
	const wrapped: EditorFactory = (tui, theme, keybindings) => {
		const editor = (previous?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings)) as TransformableEditor;
		const previousTransform = editor.transformEditorLine?.bind(editor);
		if (previousTransform) {
			editor.transformEditorLine = (line: string) => colorize(previousTransform(line), getSkillNames());
		} else {
			const previousRender = editor.render.bind(editor);
			editor.render = (width: number) => colorizeLines(previousRender(width), getSkillNames);
		}
		return editor;
	};
	return wrapped;
}

export function installEditorHighlight(ui: EditorUi, getSkillNames: () => Set<string>): void {
	installEditorLayer(ui, EDITOR_LAYER_ID, (factory) => wrapEditorFactory(factory, getSkillNames));
}
