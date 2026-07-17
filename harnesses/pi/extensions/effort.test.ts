import { describe, expect, test } from "bun:test";
import effortExtension from "./effort";

interface Harness {
	handlers: Record<string, (event: unknown, context: any) => unknown>;
	command: (args: string, context: any) => Promise<void>;
	levels: string[];
	entries: Array<{ customType: string; data: unknown }>;
}

function createHarness(): Harness {
	const handlers: Harness["handlers"] = {};
	const levels: string[] = [];
	const entries: Harness["entries"] = [];
	let command: Harness["command"] | undefined;
	let currentLevel = "off";

	effortExtension(
		{
			on(event: string, handler: Harness["handlers"][string]) {
				handlers[event] = handler;
			},
			registerCommand(_name: string, definition: { handler: Harness["command"] }) {
				command = definition.handler;
			},
			setThinkingLevel(level: string) {
				currentLevel = level;
				levels.push(level);
			},
			getThinkingLevel() {
				return currentLevel;
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		} as never,
		() => ({ "gpt-5.6-luna": "high", "gpt-5.6-sol": "medium" }),
	);

	if (!command) throw new Error("effort command was not registered");
	return { handlers, command, levels, entries };
}

function context(modelId: string, entries: Array<{ customType: string; data: unknown }> = []) {
	return {
		model: { id: modelId, reasoning: true },
		sessionManager: {
			getEntries: () => entries.map((entry) => ({ type: "custom", ...entry })),
		},
		ui: { notify() {} },
	};
}

describe("effort extension", () => {
	test("stores overrides in the current session instead of the shared defaults file", async () => {
		const first = createHarness();
		const luna = context("gpt-5.6-luna");
		await first.handlers.session_start({}, luna);
		expect(first.levels).toEqual(["high"]);

		await first.command("medium", luna);
		expect(first.entries).toEqual([
			{ customType: "effort-model-level", data: { modelId: "gpt-5.6-luna", level: "medium" } },
		]);

		const second = createHarness();
		await second.handlers.session_start({}, context("gpt-5.6-luna"));
		expect(second.levels).toEqual(["high"]);
	});

	test("restores session overrides and reapplies them when models change", async () => {
		const harness = createHarness();
		const saved = [{ customType: "effort-model-level", data: { modelId: "gpt-5.6-luna", level: "max" } }];
		await harness.handlers.session_start({}, context("gpt-5.6-luna", saved));
		await harness.handlers.model_select({}, context("gpt-5.6-sol", saved));
		await harness.handlers.model_select({}, context("gpt-5.6-luna", saved));

		expect(harness.levels).toEqual(["max", "medium", "max"]);
	});
});
