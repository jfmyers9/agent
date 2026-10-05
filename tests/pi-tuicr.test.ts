import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { ensureActionsRegistry } from "@luan.sh/pi-libactions/sdk";
import { dispatchEditorRender, ensureEditorRegistry } from "@luan.sh/pi-libtui/editor";
import { ensureMouseRegistry } from "@luan.sh/pi-libtui/mouse";
import { ReviewCommentAttachments } from "@luan.sh/pi-tuicr";
import tuicr from "../harnesses/pi/extensions/tuicr";
import { attachActionShortcuts } from "../node_modules/@luan.sh/pi-xsettings/src/runtime/actions";

test("configured review action binds through the existing shortcut host and cleans up on reload", async () => {
	const bindings = JSON.parse(await readFile(new URL("../harnesses/pi/keybindings.json", import.meta.url), "utf8"));
	const settings = JSON.parse(await readFile(new URL("../harnesses/pi/settings.json", import.meta.url), "utf8"));
	expect(bindings["panels.tuicr.open"]).toEqual(["ctrl+alt+g"]);
	const builtinBindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings).getResolvedBindings();
	for (const keys of Object.values(builtinBindings)) {
		expect(Array.isArray(keys) ? keys : [keys]).not.toContain(bindings["panels.tuicr.open"][0]);
	}
	expect(bindings["app.editor.external"]).toEqual(["ctrl+g"]);
	expect(settings.extensions).toContain("extensions/tuicr.ts");
	expect(settings.extensions.indexOf("extensions/runtime-support/index.ts")).toBeLessThan(
		settings.extensions.indexOf("extensions/tuicr.ts"),
	);
	const handlers = new Map<string, (...args: any[]) => any>();
	const shortcuts = new Map<string, any>();
	const detach = attachActionShortcuts(
		{
			registerShortcut: (key, shortcut) => {
				shortcuts.set(key, shortcut);
			},
		},
		bindings,
	);
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: {},
		ui: { theme: {}, getEditorText: () => "", setEditorText() {} },
	};
	try {
		await tuicr({
			on: (event: string, handler: (...args: any[]) => any) => {
				handlers.set(event, handler);
			},
		} as never);
		expect([...handlers.keys()].sort()).toEqual(["input", "message_start", "session_shutdown", "session_start"]);
		const start = handlers.get("session_start")!;
		start({}, { ...ctx, mode: "rpc", hasUI: false });
		expect(ensureActionsRegistry().find("panels.tuicr.open")).toBeUndefined();
		start({}, ctx);
		expect(ensureActionsRegistry().find("panels.tuicr.open")?.description).toBe("Review changes with tuicr");
		expect(shortcuts.get("ctrl+alt+g")?.description).toBe("Review changes with tuicr");
		expect(handlers.get("input")!({ source: "interactive", text: "normal prompt" })).toEqual({ action: "continue" });
		handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
		expect(ensureActionsRegistry().find("panels.tuicr.open")).toBeUndefined();
	} finally {
		handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		detach();
	}
});

test("bundled review integration shares our editor registry and expands comments only on submission", () => {
	let editorText = "Please address this";
	const ctx = {
		ui: {
			theme: { name: "test", bold: (s: string) => s, getFgAnsi: () => "\x1b[36m", getBgAnsi: () => "\x1b[40m" },
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	};
	const scope = Object.create(null) as typeof globalThis;
	const registry = ensureEditorRegistry(scope);
	const comments = new ReviewCommentAttachments(ctx as never, registry, ensureMouseRegistry(scope));
	try {
		comments.publish([{ id: "one", content: "Handle an empty result", location: "src/example.ts:8" }]);
		expect(editorText).not.toContain("Handle an empty result");
		expect(Bun.stripANSI(dispatchEditorRender(registry, [editorText], 80).join("\n"))).toContain("1 review comments");
		expect(comments.transform(editorText)).toContain("`src/example.ts:8` - Handle an empty result");
	} finally {
		comments.dispose();
	}
	expect(editorText).toBe("Please address this");
});
