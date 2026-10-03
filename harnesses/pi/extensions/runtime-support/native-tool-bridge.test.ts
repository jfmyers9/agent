/*
Adapted from luan/agents fe1d4ddc (pi-libtui).

MIT License

Copyright (c) 2026 Luan Santos

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCodemodeExtension,
	createReadToolDefinition,
	createToolSearchExtension,
	DefaultResourceLoader,
	type ExtensionContext,
	initTheme,
	SettingsManager,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	setCapabilities,
	ProcessTerminal,
	stripTerminalSequences,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import runtimeSupport from "./index";
import { installNativeToolBridge } from "./native-tool-bridge";

const disposers: Array<() => void> = [];
const tui = new TuiAltScreen(new ProcessTerminal());
let root: string;
let definitions: Map<string, ToolDefinition>;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-native-tool-framing-"));
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager: SettingsManager.inMemory(),
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [createCodemodeExtension(), createToolSearchExtension()],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	definitions = new Map(
		loader
			.getExtensions()
			.extensions.flatMap((extension) => [...extension.tools].map(([name, tool]) => [name, tool.definition])),
	);
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});
beforeEach(() => initTheme("dark", false));
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

function codemode(code = "text(ALL_TOOLS.map(({ name }) => name));") {
	return new ToolExecutionComponent("codemode", "script", { code }, {}, definitions.get("codemode"), tui, "/tmp");
}

test.each([40, 80, 160])("native codemode keeps bounded, unpainted previews at %i columns", (width) => {
	disposers.push(installNativeToolBridge());
	const component = codemode();
	component.updateResult({
		content: [
			{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text", text: JSON.stringify(Array.from({ length: 300 }, (_, i) => `tool_${i}`)) },
		],
		details: { calls: [{ id: "script/1", name: "exec_command", args: '{"cmd":"pwd"}', status: "ok", durationMs: 10 }] },
		isError: false,
	});
	const lines = component.render(width);
	const text = lines.map(stripTerminalSequences).join("\n");
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	expect(lines.join("\n")).not.toMatch(/\x1b\[(?:48|4[0-7]);?[^m]*m/);
	expect(text).toContain("exec_command");
	expect(text).toContain("pwd");
	expect(text).toContain("more lines");
	expect(text).not.toContain("Script completed");
	expect(lines.length).toBeLessThanOrEqual(12);
	component.setExpanded(true);
	expect(component.render(width).length).toBeGreaterThan(lines.length);
});

test("native tool search keeps its result and click-to-expand at the compact row coordinates", () => {
	const component = new ToolExecutionComponent(
		"tool_search",
		"search",
		{ query: "filesystem shell" },
		{},
		definitions.get("tool_search"),
		tui,
		"/tmp",
	);
	component.updateResult({
		content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `result ${i}`).join("\n") }],
		isError: false,
	});
	const native = component.render(80);
	disposers.push(installNativeToolBridge());
	const compact = component.render(80);
	expect(compact.length).toBe(native.length - 2);
	expect(compact.map(stripTerminalSequences).join("\n")).toContain("result 0");
	expect(
		component.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: 2,
			screenX: 0,
			screenY: 2,
			shift: false,
			alt: false,
			ctrl: false,
			width: 80,
			height: compact.length,
		})?.handled,
	).toBe(true);
	expect(component.render(80).map(stripTerminalSequences).join("\n")).toContain("result 14");
});

test("independent host leases restore native framing", () => {
	const component = codemode("text('done');");
	component.updateResult({
		content: [{ type: "text", text: "done" }],
		details: { calls: [] },
		isError: false,
	});
	const native = component.render(80);
	const first = installNativeToolBridge();
	const second = installNativeToolBridge();
	disposers.push(first, second);
	const compact = component.render(80);
	expect(compact.length).toBeLessThan(native.length);
	first();
	first();
	expect(component.render(80)).toEqual(compact);
	second();
	expect(component.render(80)).toEqual(native);
});

test.each(["codemode", "tool_search"])("%s errors keep Pi's visible failure feedback", (name) => {
	const component = new ToolExecutionComponent(name, "failed", {}, {}, definitions.get(name), tui, "/tmp");
	component.updateResult({ content: [{ type: "text", text: "Execution failed" }], isError: true });
	const native = component.render(80);
	disposers.push(installNativeToolBridge());
	expect(component.render(80)).toEqual(native);
	expect(native.map(stripTerminalSequences).join("\n")).toContain("Execution failed");
});

test("ordinary feature tool framing stays owned by its renderer", () => {
	const definition = createReadToolDefinition("/tmp");
	const component = new ToolExecutionComponent("read", "read", { path: "file.ts" }, {}, definition, tui, "/tmp");
	const native = component.render(80);
	disposers.push(installNativeToolBridge());
	expect(component.render(80)).toEqual(native);
});

test.each([
	["toolDefinition", undefined],
	["hideComponent", undefined],
	["hideComponent", true],
	["imageComponents", undefined],
	["contentBox", undefined],
])("unknown or hidden private shape (%s=%s) keeps Pi's renderer", (key, value) => {
	const component = codemode();
	Reflect.set(component, key, value);
	const native = component.render(80);
	disposers.push(installNativeToolBridge());
	expect(component.render(80)).toEqual(native);
});

test("self-framed renderers are not compacted again", () => {
	const definition = { ...definitions.get("codemode")!, renderShell: "self" as const };
	const component = new ToolExecutionComponent("codemode", "self", { code: "text(1)" }, {}, definition, tui, root);
	const native = component.render(80);
	disposers.push(installNativeToolBridge());
	expect(component.render(80)).toEqual(native);
});

test("image results keep Pi's complete layout", () => {
	const caps = getCapabilities();
	try {
		setCapabilities({ ...caps, images: "iterm2" });
		const component = codemode();
		component.updateResult({
			content: [
				{ type: "text", text: "Image result" },
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
				},
			],
			isError: false,
		});
		expect(Reflect.get(component, "imageComponents")).toHaveLength(1);
		const native = component.render(80);
		disposers.push(installNativeToolBridge());
		expect(component.render(80)).toEqual(native);
	} finally {
		setCapabilities(caps);
	}
});

test("compact spacer ignores mouse input and disposal restores both methods", () => {
	const prototype = ToolExecutionComponent.prototype;
	const render = prototype.render;
	const mouse = prototype.handleMouse;
	const component = codemode();
	const dispose = installNativeToolBridge();
	disposers.push(dispose);
	const lines = component.render(80);
	expect(
		component.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			shift: false,
			alt: false,
			ctrl: false,
			width: 80,
			height: lines.length,
		}),
	).toBeUndefined();
	expect(component.render(80)).toEqual(lines);
	dispose();
	expect(prototype.render).toBe(render);
	expect(prototype.handleMouse).toBe(mouse);
	expect(Reflect.has(prototype, Symbol.for("pi-libtui/native-tool-bridge/v1"))).toBe(false);
});

test("disposal preserves later wrappers and makes retained bridge wrappers inert", () => {
	const prototype = ToolExecutionComponent.prototype;
	const render = prototype.render;
	const mouse = prototype.handleMouse;
	const component = codemode();
	const native = component.render(80);
	const dispose = installNativeToolBridge();
	disposers.push(dispose);
	const bridgeRender = prototype.render;
	const bridgeMouse = prototype.handleMouse;
	const laterRender: typeof render = function (width) {
		return bridgeRender.call(this, width);
	};
	const laterMouse: typeof mouse = function (event) {
		return bridgeMouse.call(this, event);
	};
	try {
		prototype.render = laterRender;
		prototype.handleMouse = laterMouse;
		dispose();
		expect(prototype.render).toBe(laterRender);
		expect(prototype.handleMouse).toBe(laterMouse);
		expect(component.render(80)).toEqual(native);
		const reacquired = installNativeToolBridge();
		disposers.push(reacquired);
		expect(component.render(80).length).toBeLessThan(native.length);
		reacquired();
		expect(prototype.render).toBe(laterRender);
	} finally {
		prototype.render = render;
		prototype.handleMouse = mouse;
	}
});

test("runtime support acquires once per UI session and releases on shutdown/reload", async () => {
	const prototype = ToolExecutionComponent.prototype;
	const render = prototype.render;
	const mouse = prototype.handleMouse;
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager: SettingsManager.inMemory(),
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [runtimeSupport],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const extension = loader.getExtensions().extensions[0]!;
	// The bridge's handlers follow the loaded packages' handlers. Exercise only
	// these lifecycle hooks; the packages' UI hosts require a running terminal.
	const start = extension.handlers.get("session_start")!.at(-1)!;
	const shutdown = extension.handlers.get("session_shutdown")!.at(-1)!;
	const ctx = { hasUI: true, mode: "tui" } as ExtensionContext;
	try {
		expect(prototype.render).toBe(render); // Loading alone has no global effects.
		await start({ type: "session_start" }, { hasUI: false, mode: "print" } as ExtensionContext);
		expect(prototype.render).toBe(render);
		await start({ type: "session_start" }, { hasUI: true, mode: "rpc" } as ExtensionContext);
		expect(prototype.render).toBe(render);
		expect(prototype.handleMouse).toBe(mouse);
		await start({ type: "session_start" }, ctx);
		expect(prototype.render).not.toBe(render);
		await start({ type: "session_start" }, ctx); // A session switch is not another lease.
		await shutdown({ type: "session_shutdown" }, ctx);
		expect(prototype.render).toBe(render);
		expect(prototype.handleMouse).toBe(mouse);
		await shutdown({ type: "session_shutdown" }, ctx);
		await start({ type: "session_start" }, ctx);
		expect(prototype.render).not.toBe(render);
	} finally {
		await shutdown({ type: "session_shutdown" }, ctx);
	}
	expect(prototype.render).toBe(render);
	expect(prototype.handleMouse).toBe(mouse);
});
