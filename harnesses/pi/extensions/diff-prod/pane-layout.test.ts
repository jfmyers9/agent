import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, ScrollView, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { DiffPane } from "./pane.js";

// Exercise the installed library's real bridge, without replacing global modules.
const library = new URL(import.meta.resolve("@luan.sh/pi-libtui"));
const { installSplitPaneBridge } = await import(new URL("host/split-pane-bridge.ts", library).href);
const { ensureSplitPaneRegistry } = await import(new URL("split-pane.ts", library).href);
const { ensureMouseRegistry } = await import(new URL("mouse.ts", library).href);

const diff = [
	"diff --git a/app.ts b/app.ts",
	"--- a/app.ts",
	"+++ b/app.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	...Array.from({ length: 40 }, (_, i) => ` context ${i}`),
].join("\n");
const theme = {
	name: "test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[36m",
	getBgAnsi: () => "\x1b[40m",
	fg: (color: string, text: string) => `\x1b[${color === "success" ? 32 : color === "error" ? 31 : 36}m${text}\x1b[0m`,
} as unknown as Theme;

interface Box {
	component: Component;
	rect: { x: number; y: number; width: number; height: number };
	children: Box[];
}

function fixture() {
	const terminal = {
		columns: 140,
		rows: 16,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	};
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const main = { focused: false, render: (width: number) => ["M".repeat(width)], invalidate() {} };
	const root = new ScrollView(main, { primary: true });
	const scope = Object.create(null) as typeof globalThis;
	const registry = ensureSplitPaneRegistry(scope);
	const release = installSplitPaneBridge(tui, () => theme, registry, ensureMouseRegistry(scope));
	tui.setLayoutRoot(root);
	tui.setFocus(main);
	tui.start();
	const pane = new DiffPane(
		async () => diff,
		() => ({ ...terminal, fullscreen: true }),
		(definition) => registry.mount(definition),
	);
	return {
		tui,
		terminal,
		main,
		root,
		pane,
		render() {
			tui.renderNow(true);
			return Reflect.get(tui, "currentLayout") as { root: Box; lines: string[] };
		},
		close() {
			pane.dispose();
			tui.stop();
			release();
		},
	};
}

describe("production diff real fullscreen layout", () => {
	test("reserves a right column rather than covering the transcript", async () => {
		const f = fixture();
		try {
			await f.pane.refresh();
			const frame = f.render();
			const main = frame.root.children.find((box) => box.component === f.root);
			expect(main).toBeDefined();
			expect(main?.rect.x).toBe(0);
			expect(main?.rect.width).toBe(85);
			const line = stripTerminalSequences(frame.lines[0] ?? "");
			expect(line).toStartWith(`${"M".repeat(85)} │Production diff`);
			expect(frame.lines.every((line) => visibleWidth(line) <= f.terminal.columns)).toBe(true);
			expect(frame.lines.length).toBeLessThanOrEqual(f.terminal.rows);
		} finally {
			f.close();
		}
	});

	test("off and disposal restore the exact original root and its full width", async () => {
		const f = fixture();
		try {
			await f.pane.refresh();
			f.pane.setEnabled(false);
			expect(Reflect.get(f.tui, "layoutRoot")).toBe(f.root);
			expect(stripTerminalSequences(f.render().lines[0] ?? "")).toBe("M".repeat(140));
			f.pane.setEnabled(true);
			await f.pane.refresh();
			expect(Reflect.get(f.tui, "layoutRoot")).not.toBe(f.root);
			f.pane.dispose();
			expect(Reflect.get(f.tui, "layoutRoot")).toBe(f.root);
			expect(stripTerminalSequences(f.render().lines[0] ?? "")).toBe("M".repeat(140));
		} finally {
			f.close();
		}
	});

	test("focus is opt-in, Escape restores editor, and narrowing releases focused pane", async () => {
		const f = fixture();
		try {
			await f.pane.refresh();
			f.render();
			expect(f.tui.getFocusedComponent()).toBe(f.main);
			expect(f.pane.focus()).toBe(true);
			expect(f.tui.getFocusedComponent()).not.toBe(f.main);
			f.tui.getFocusedComponent()?.handleInput?.("\x1b");
			expect(f.tui.getFocusedComponent()).toBe(f.main);
			f.pane.focus();
			f.terminal.columns = 100;
			f.pane.syncLayout();
			expect(f.tui.getFocusedComponent()).toBe(f.main);
			expect(Reflect.get(f.tui, "layoutRoot")).toBe(f.root);
			expect(stripTerminalSequences(f.render().lines[0] ?? "")).toBe("M".repeat(100));
			expect(f.pane.focus()).toBe(false);
			f.terminal.columns = 140;
			f.pane.syncLayout();
			expect(stripTerminalSequences(f.render().lines[0] ?? "")).toContain("Production diff");
			expect(f.tui.getFocusedComponent()).toBe(f.main);
		} finally {
			f.close();
		}
	});

	test("renders colored additions/removals and scrolls inside bounded viewport", async () => {
		const f = fixture();
		try {
			await f.pane.refresh();
			const before = f.render();
			expect(before.lines.join("\n")).toContain("\x1b[32m+new");
			expect(before.lines.join("\n")).toContain("\x1b[31m-old");
			expect(before.lines.map(stripTerminalSequences).join("\n")).not.toContain("context 39");
			f.pane.focus();
			f.tui.getFocusedComponent()?.handleInput?.("G");
			const after = f.render();
			expect(after.lines.map(stripTerminalSequences).join("\n")).toContain("context 39");
			expect(after.lines.length).toBeLessThanOrEqual(f.terminal.rows);
			expect(after.lines.every((line) => visibleWidth(line) <= f.terminal.columns)).toBe(true);
			expect(stripTerminalSequences(after.lines[0] ?? "")).toStartWith("M".repeat(85));
		} finally {
			f.close();
		}
	});
});
