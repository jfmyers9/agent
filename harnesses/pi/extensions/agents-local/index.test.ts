import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentsLocalExtension from ".";

let tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

function createTempProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "agents-local-test-"));
	tempDirs.push(dir);
	return dir;
}

function registerBeforeAgentStartHandler() {
	let handler:
		| ((
				event: { systemPrompt: string; systemPromptOptions: { cwd: string; contextFiles?: unknown[] } },
				ctx: { cwd: string },
		  ) => unknown)
		| undefined;

	agentsLocalExtension({
		on: (event: string, fn: typeof handler) => {
			if (event === "before_agent_start") {
				handler = fn;
			}
		},
		registerCommand: () => {},
	} as never);

	if (!handler) {
		throw new Error("before_agent_start handler was not registered");
	}

	return handler;
}

describe("agents-local extension", () => {
	test("contributes local context as structured system prompt context files", async () => {
		const cwd = createTempProject();
		const localPath = join(cwd, "CLAUDE.local.md");
		writeFileSync(localPath, "LOCAL_SENTINEL");

		const handler = registerBeforeAgentStartHandler();
		const event = { systemPrompt: "base", systemPromptOptions: { cwd } };
		const result = (await handler(event, { cwd })) as { systemPrompt: string };

		expect(event.systemPromptOptions.contextFiles).toEqual([{ path: localPath, content: "LOCAL_SENTINEL" }]);
		expect(result.systemPrompt).toContain("# Local Project Context");
		expect(result.systemPrompt).toContain("LOCAL_SENTINEL");
	});

	test("does not duplicate a context file already present in system prompt options", async () => {
		const cwd = createTempProject();
		const localPath = join(cwd, "CLAUDE.local.md");
		writeFileSync(localPath, "LOCAL_SENTINEL");

		const handler = registerBeforeAgentStartHandler();
		const event = {
			systemPrompt: "base",
			systemPromptOptions: {
				cwd,
				contextFiles: [{ path: localPath, content: "EXISTING" }],
			},
		};

		await handler(event, { cwd });

		expect(event.systemPromptOptions.contextFiles).toEqual([{ path: localPath, content: "EXISTING" }]);
	});
});
