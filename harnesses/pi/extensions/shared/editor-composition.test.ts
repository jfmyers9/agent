import { describe, expect, test } from "bun:test";
import { type EditorFactory, installEditorLayer } from "./editor-composition";

describe("shared editor composition", () => {
	function composeInOrder(order: Array<"keys" | "render">) {
		let factory: EditorFactory | undefined;
		const ui = {
			getEditorComponent: () => factory,
			setEditorComponent: (next: EditorFactory | undefined) => {
				factory = next;
			},
		};

		const keyLayer = Symbol("keys");
		const renderLayer = Symbol("render");
		for (const layer of order) {
			if (layer === "keys") {
				installEditorLayer(ui, keyLayer, (previous) => (tui, theme, keybindings) => {
					const editor = previous?.(tui, theme, keybindings) ?? {
						render: () => ["base"],
						invalidate() {},
						handleInput() {},
					};
					const previousHandleInput = editor.handleInput?.bind(editor);
					editor.handleInput = (data: string) => {
						if (data === "x") {
							editor.setText?.("handled");
							return;
						}
						previousHandleInput?.(data);
					};
					return editor;
				});
			} else {
				installEditorLayer(ui, renderLayer, (previous) => (tui, theme, keybindings) => {
					const editor = previous?.(tui, theme, keybindings) ?? {
						render: () => ["base"],
						invalidate() {},
					};
					const previousRender = editor.render.bind(editor);
					editor.render = (width: number) => previousRender(width).map((line) => `${line}:rendered`);
					return editor;
				});
			}
		}

		let text = "";
		ui.setEditorComponent(() => ({
			render: () => ["replacement"],
			invalidate() {},
			setText: (next: string) => {
				text = next;
			},
			handleInput: () => {
				text = "base";
			},
		}));

		return { factory, getText: () => text };
	}

	test("keeps all editor layers when the base editor is replaced later", () => {
		for (const order of [
			["keys", "render"],
			["render", "keys"],
		] as const) {
			const { factory, getText } = composeInOrder([...order]);
			const editor = factory?.(undefined as never, undefined as never, undefined as never);
			expect(editor?.render(80)).toEqual(["replacement:rendered"]);
			editor?.handleInput?.("x");
			expect(getText()).toBe("handled");
		}
	});
});
