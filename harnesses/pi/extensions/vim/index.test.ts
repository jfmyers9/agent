import { describe, expect, test } from "bun:test";

import { CURSOR_MARKER, TUI } from "@earendil-works/pi-tui";

import { installStableHardwareCursorVisibility, ModalEditor } from "./index";

class FakeTerminal {
	public shown = 0;
	public hidden = 0;
	public writes: string[] = [];

	start() {}
	stop() {}
	async drainInput() {}
	write(data: string) {
		this.writes.push(data);
	}
	get columns() {
		return 80;
	}
	get rows() {
		return 24;
	}
	get kittyProtocolActive() {
		return false;
	}
	moveBy() {}
	hideCursor() {
		this.hidden += 1;
	}
	showCursor() {
		this.shown += 1;
	}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

async function flushRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("vim hardware cursor stability", () => {
	test("uses blinking cursor-shape sequences only on state changes, not on redraw", () => {
		const writes: string[] = [];
		const editor = new ModalEditor(
			{
				terminal: {
					write(sequence: string) {
						writes.push(sequence);
					},
				},
				setShowHardwareCursor() {},
				getShowHardwareCursor() {
					return true;
				},
			} as never,
			{} as never,
			{} as never,
		);

		expect(writes).toContain("\x1b[5 q");
		const writesAfterInit = writes.length;

		(editor as unknown as { borderColor: (text: string) => string }).borderColor = (text: string) => text;
		(editor as unknown as { focused: boolean }).focused = true;
		editor.render(80);
		editor.render(80);
		expect(writes.length).toBe(writesAfterInit);

		editor.handleInput("\x1b");
		expect(writes).toContain("\x1b[1 q");
		const writesAfterNormal = writes.length;
		editor.render(80);
		expect(writes.length).toBe(writesAfterNormal);

		editor.handleInput("i");
		expect(writes.filter((value) => value === "\x1b[5 q").length).toBeGreaterThanOrEqual(2);
		expect(writes).not.toContain("\x1b[6 q");
		expect(writes).not.toContain("\x1b[2 q");
	});

	test("dedupes repeated showCursor calls across steady renders", async () => {
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const cleanup = installStableHardwareCursorVisibility(tui);

		const editorLike = {
			focused: false,
			render() {
				return [`prompt ${CURSOR_MARKER}x`];
			},
			invalidate() {},
		};

		tui.addChild(editorLike as never);
		tui.setFocus(editorLike as never);
		tui.setShowHardwareCursor(true);
		await flushRender();
		tui.requestRender(true);
		await flushRender();
		tui.requestRender();
		await flushRender();
		tui.requestRender();
		await flushRender();

		expect(terminal.shown).toBe(1);
		expect(terminal.hidden).toBe(0);

		cleanup?.();
	});

	test("still allows real visibility transitions", async () => {
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const cleanup = installStableHardwareCursorVisibility(tui);

		let showMarker = true;
		const editorLike = {
			focused: false,
			render() {
				return [showMarker ? `prompt ${CURSOR_MARKER}x` : "prompt x"];
			},
			invalidate() {},
		};

		tui.addChild(editorLike as never);
		tui.setFocus(editorLike as never);
		tui.setShowHardwareCursor(true);
		await flushRender();
		tui.requestRender(true);
		await flushRender();

		showMarker = false;
		tui.requestRender();
		await flushRender();

		showMarker = true;
		tui.requestRender();
		await flushRender();

		expect(terminal.shown).toBe(2);
		expect(terminal.hidden).toBe(1);

		cleanup?.();
	});
});
