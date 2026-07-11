import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApplyPatch, runLocalApplyPatch } from "./backend";
import applyPatchExtension from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-apply-patch-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("apply_patch parser", () => {
	test("parses Codex file operations", () => {
		const operations = parseApplyPatch(`*** Begin Patch
*** Add File: new.txt
+hello
*** Move File: old.txt -> moved.txt
*** Delete File: gone.txt
*** End Patch`);

		expect(operations).toHaveLength(3);
		expect(operations[0]).toMatchObject({ type: "add", path: "new.txt" });
		expect(operations[1]).toMatchObject({ type: "move", movePath: "moved.txt" });
	});
});

describe("apply_patch backend", () => {
	test("applies updates, creates files, and preserves CRLF", async () => {
		const directory = await temporaryDirectory();
		await writeFile(join(directory, "file.txt"), "one\r\ntwo\r\n", "utf8");

		const result = await runLocalApplyPatch(
			directory,
			`*** Begin Patch
*** Update File: file.txt
@@ lines 1-2
-one
+ONE
 two
*** Add File: added.txt
+created
*** End Patch`,
		);

		expect(result.changes).toHaveLength(2);
		expect(await readFile(join(directory, "file.txt"), "utf8")).toBe("ONE\r\ntwo\r\n");
		expect(await readFile(join(directory, "added.txt"), "utf8")).toBe("created\n");
	});

	test("preflights all operations before writing", async () => {
		const directory = await temporaryDirectory();
		await writeFile(join(directory, "file.txt"), "one\n", "utf8");

		await expect(
			runLocalApplyPatch(
				directory,
				`*** Begin Patch
*** Update File: file.txt
@@ lines 1-1
-one
+ONE
*** Update File: missing.txt
@@ lines 1-1
-nope
+NOPE
*** End Patch`,
			),
		).rejects.toThrow("File does not exist: missing.txt");
		expect(await readFile(join(directory, "file.txt"), "utf8")).toBe("one\n");
	});
});

describe("apply_patch tool policy", () => {
	test("activates apply_patch only for GPT models", () => {
		let activeTools = ["read", "edit", "write"];
		const handlers: Record<string, (event: unknown, context: unknown) => unknown> = {};
		let registeredName = "";
		const pi = {
			registerTool(definition: { name: string }) {
				registeredName = definition.name;
			},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(next: string[]) {
				activeTools = next;
			},
			on(event: string, handler: (event: unknown, context: unknown) => unknown) {
				handlers[event] = handler;
			},
		};

		applyPatchExtension(pi as never);
		handlers.session_start?.({}, { model: { id: "gpt-5.5", provider: "openai" } });
		expect(registeredName).toBe("apply_patch");
		expect(activeTools).toContain("apply_patch");
		expect(activeTools).not.toContain("edit");
		expect(activeTools).not.toContain("write");

		handlers.model_select?.({}, { model: { id: "claude-sonnet-4-6", provider: "anthropic" } });
		expect(activeTools).not.toContain("apply_patch");
		expect(activeTools).toEqual(["read", "edit", "write"]);
	});
});
