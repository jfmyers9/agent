import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import applyPatchExtension from "../apply-patch/index";
import fileopsExtension from "../fileops/index";
import { FILE_MUTATION_EVENT } from "../shared/file-mutations";
import diffProd from "./index";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "pi-turn-diff-"));
	directories.push(path);
	return path;
}

function session(cwd: string) {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const subscribers = new Map<string, Set<(data: unknown) => void>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	let rendered = "";
	const pi = {
		on(name: string, handler: any) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, callback: (data: unknown) => void) {
				const listeners = subscribers.get(name) ?? new Set();
				listeners.add(callback);
				subscribers.set(name, listeners);
				return () => {
					listeners.delete(callback);
				};
			},
			emit(name: string, data: unknown) {
				for (const listener of subscribers.get(name) ?? []) listener(data);
			},
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerShortcut() {},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		getActiveTools: () => [],
		setActiveTools() {},
		exec: async () => {
			throw new Error("Turn scope must not read Git");
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: true,
		mode: "test",
		model: undefined,
		ui: {
			notify: (message: string) => notifications.push(message),
			custom: async (factory: any) => {
				const view = factory(
					{ terminal: { rows: 10_000 }, requestRender() {} },
					{ fg: (_: string, text: string) => text } as Theme,
					{},
					() => {},
				);
				rendered = view.render(300).join("\n");
			},
		},
	};
	const emit = async (name: string, data: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(data, ctx);
	};
	diffProd(pi);
	applyPatchExtension(pi);
	fileopsExtension(pi);
	let next = 0;
	return {
		pi,
		emit,
		notifications,
		start: () => emit("session_start"),
		user: () => emit("message_start", { message: { role: "user", content: [] } }),
		async call(name: string, args: unknown, parentToolCallId?: string) {
			const toolCallId = parentToolCallId ? `${parentToolCallId}/${++next}` : `call-${++next}`;
			await emit("tool_execution_start", { toolName: name, toolCallId, args, parentToolCallId });
			try {
				return await tools.get(name).execute(toolCallId, args, undefined, undefined, ctx);
			} finally {
				await emit("tool_execution_end", { toolName: name, toolCallId, parentToolCallId });
			}
		},
		async overlay() {
			rendered = "";
			await commands.get("diff-prod").handler("", ctx);
			return rendered;
		},
	};
}

const patch = (file: string, before: string, after: string) => ({
	input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch`,
});

test("sessions in one directory retain only their own edits across model turns and settlement", async () => {
	const cwd = await directory();
	await writeFile(join(cwd, "a"), "pre-existing\nstart\n");
	await writeFile(join(cwd, "b"), "other\n");
	const a = session(cwd);
	const b = session(cwd);
	await a.start();
	await b.start();
	await a.user();
	await b.user();
	await a.call("apply_patch", patch("a", "start", "middle"), "codemode-a");
	await a.emit("turn_end");
	await a.emit("turn_start");
	await b.call("apply_patch", patch("b", "other", "session-b"), "codemode-b");
	await a.call("apply_patch", patch("a", "middle", "final"));
	await a.emit("agent_settled");
	const diff = await a.overlay();
	expect(diff).toContain("This turn");
	expect(diff).toContain("-start");
	expect(diff).toContain("+final");
	expect(diff).not.toContain("+middle");
	expect(diff).not.toContain("+pre-existing");
	expect(diff).not.toContain("session-b");
	expect(await b.overlay()).toContain("+session-b");
	await writeFile(join(cwd, "a"), "external\n");
	expect(await a.overlay()).toBe(diff);
	await a.user();
	await a.call("read", { path: "a", raw: true });
	expect(await a.overlay()).toBe("");
	expect(a.notifications.at(-1)).toContain("No captured changes");
	// A late completion from the previous interaction must not attach to this one.
	a.pi.events.emit(FILE_MUTATION_EVENT, {
		toolCallId: "call-2",
		path: join(cwd, "a"),
		before: "external\n",
		after: "late\n",
	});
	expect(await a.overlay()).toBe("");
	await a.emit("session_shutdown");
	await b.emit("session_shutdown");
});

test("write and hashline edits publish actual snapshots, with no snapshots in tool results", async () => {
	const cwd = await directory();
	const s = session(cwd);
	await s.start();
	await s.user();
	const written = await s.call("write", { path: "new.test.ts", content: "one\n" }, "code");
	expect(written.details?.before).toBeUndefined();
	const result = await s.call("read", { path: "new.test.ts" });
	const header = result.content[0].text.split("\n")[0];
	await s.call("edit", { input: `${header}\n1 1\n+two\n` }, "code");
	let diff = await s.overlay();
	expect(diff).toContain("Added: new.test.ts");
	expect(diff).toContain("+two");
	expect(diff).not.toContain("+one");
	expect(await readFile(join(cwd, "new.test.ts"), "utf8")).toContain("two");
	await s.call("apply_patch", {
		input: "*** Begin Patch\n*** Move File: new.test.ts -> moved.ts\n*** Add File: empty\n*** End Patch",
	});
	diff = await s.overlay();
	expect(diff).toContain("Added: moved.ts");
	expect(diff).toContain("Added: empty");
	expect(diff).not.toContain("new.test.ts");
	await s.emit("session_shutdown");
});

test("same-file interleaving shows separate segments without attributing the other writer", async () => {
	const cwd = await directory();
	await writeFile(join(cwd, "a"), "one\n");
	const s = session(cwd);
	await s.start();
	await s.user();
	await s.call("apply_patch", patch("a", "one", "two"));
	await writeFile(join(cwd, "a"), "external\ntwo\n");
	await s.call("apply_patch", patch("a", "two", "three"));
	const diff = await s.overlay();
	expect(diff).toContain("Interleaved changes detected");
	expect(diff).not.toContain("+external");
	expect(diff).toContain("+three");
	await s.emit("session_tree");
	expect(await s.overlay()).toBe("");
	await s.emit("session_shutdown");
});
