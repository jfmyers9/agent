import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createToolToggleController,
	filterDisabledToolPromptLines,
	loadToolToggleConfig,
	removeDisabledToolsFromPromptOptions,
} from "./tool-toggles";

type Handler = (...args: any[]) => unknown;

function createPi(activeTools: string[], disabledTools = ["ls", "grab", "find"], configPath?: string) {
	const handlers = new Map<string, Handler[]>();
	const actionCalls: string[][] = [];
	const pi = {
		getActiveTools: () => {
			actionCalls.push(["getActiveTools"]);
			return activeTools;
		},
		setActiveTools: (next: string[]) => {
			activeTools = next;
			actionCalls.push(["setActiveTools", ...next]);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};

	const controller = createToolToggleController(pi, disabledTools, configPath);
	controller.install();

	return { controller, handlers, actionCalls, getActiveTools: () => activeTools };
}

describe("token-burden tool toggles", () => {
	test("removes configured default tools from active tools", () => {
		const pi = createPi(["read", "ls", "grab", "find", "exec_command"]);

		expect(pi.actionCalls).toEqual([]);

		pi.handlers.get("session_start")?.[0]?.({}, {});

		expect(pi.getActiveTools()).toEqual(["read", "exec_command"]);
		expect(pi.actionCalls).toEqual([["getActiveTools"], ["setActiveTools", "read", "exec_command"]]);
	});

	test("does not call action methods during install", () => {
		const pi = createPi(["read", "exec_command"], ["read"]);

		expect(pi.actionCalls).toEqual([]);
	});

	test("removes disabled tools during resources discovery before prompt rebuilds", () => {
		const pi = createPi(["read", "exec_command"], ["read"]);

		pi.handlers.get("resources_discover")?.[0]?.({}, {});

		expect(pi.getActiveTools()).toEqual(["exec_command"]);
		expect(pi.actionCalls).toEqual([["getActiveTools"], ["setActiveTools", "exec_command"]]);
	});

	test("blocks configured tool calls as a safety net while inactive", () => {
		const pi = createPi(["read", "exec_command"]);

		const result = pi.handlers.get("tool_call")?.[0]?.({ toolName: "grab" }, {});

		expect(result).toEqual({
			block: true,
			reason: "grab is disabled by the token-burden extension. Toggle it on from /token-burden if needed.",
		});
	});

	test("blocks disabled tool calls even if a stale active tool list still contains them", () => {
		const pi = createPi(["read", "exec_command"], ["read"]);

		const result = pi.handlers.get("tool_call")?.[0]?.({ toolName: "read" }, {});

		expect(result).toEqual({
			block: true,
			reason: "read is disabled by the token-burden extension. Toggle it on from /token-burden if needed.",
		});
	});

	test("filters stale disabled-tool prompt bullets", () => {
		const prompt = [
			"Available tools:",
			"- read: Read file contents.",
			"- exec_command: Run a command.",
			"",
			"Guidelines:",
			"- Use read to examine files instead of cat or sed.",
			"- Use `apply_patch` for manual code edits.",
			"- Use codex_apps_github_fetch only when GitHub is required.",
			"- Be concise in your responses",
		].join("\n");

		const filtered = filterDisabledToolPromptLines(prompt, (toolName) =>
			["read", "codex_apps_github_fetch"].includes(toolName),
		);

		expect(filtered).toBe(
			[
				"Available tools:",
				"- exec_command: Run a command.",
				"",
				"Guidelines:",
				"- Use `apply_patch` for manual code edits.",
				"- Be concise in your responses",
			].join("\n"),
		);
	});

	test("before_agent_start returns a prompt with stale disabled-tool bullets removed", () => {
		const pi = createPi(["read", "exec_command"], ["read"]);

		const result = pi.handlers.get("before_agent_start")?.[0]?.(
			{
				systemPrompt: [
					"Available tools:",
					"- read: Read file contents.",
					"",
					"Guidelines:",
					"- Use read to examine files instead of cat or sed.",
				].join("\n"),
			},
			{},
		);

		expect(pi.getActiveTools()).toEqual(["exec_command"]);
		expect(result).toEqual({
			systemPrompt: ["Available tools:", "", "Guidelines:"].join("\n"),
		});
	});

	test("before_agent_start mutates prompt options so later prompt builders cannot re-add disabled guidelines", () => {
		const pi = createPi(["read", "exec_command"], ["read"]);
		const systemPromptOptions = {
			selectedTools: ["read", "exec_command"],
			toolSnippets: {
				read: "Read file contents.",
				exec_command: "Run a command.",
			},
			promptGuidelines: [
				"Use read to examine files instead of cat or sed.",
				"Use exec_command for search, listing files, and local text-file reads.",
			],
		};

		pi.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base", systemPromptOptions }, {});

		expect(systemPromptOptions).toEqual({
			selectedTools: ["exec_command"],
			toolSnippets: {
				exec_command: "Run a command.",
			},
			promptGuidelines: ["Use exec_command for search, listing files, and local text-file reads."],
		});
	});

	test("removes disabled tools from structured prompt options", () => {
		const options = {
			selectedTools: ["read", "exec_command", "codex_apps_github_fetch"],
			toolSnippets: {
				read: "Read file contents.",
				exec_command: "Run a command.",
				codex_apps_github_fetch: "Fetch a file.",
			},
			promptGuidelines: [
				"Use read to examine files instead of cat or sed.",
				"Use exec_command for search, listing files, and local text-file reads.",
				"Use codex_apps_github_fetch only when GitHub is required.",
			],
		};

		removeDisabledToolsFromPromptOptions(options, (toolName) =>
			["read", "codex_apps_github_fetch"].includes(toolName),
		);

		expect(options).toEqual({
			selectedTools: ["exec_command"],
			toolSnippets: {
				exec_command: "Run a command.",
			},
			promptGuidelines: ["Use exec_command for search, listing files, and local text-file reads."],
		});
	});

	test("toggle result enables namespaced tools and allows them through safety net", () => {
		const pi = createPi(["read", "exec_command"]);

		const toggleResult = pi.controller.setToolActive("functions.find", true);
		const blockResult = pi.handlers.get("tool_call")?.[0]?.({ toolName: "functions.find" }, {});

		expect(toggleResult).toEqual({
			applied: true,
			activeToolNames: ["read", "exec_command", "functions.find"],
		});
		expect(blockResult).toBeUndefined();
		expect(pi.getActiveTools()).toEqual(["read", "exec_command", "functions.find"]);
	});

	test("toggle result disables active tools and blocks later calls", () => {
		const pi = createPi(["read", "exec_command"]);

		pi.controller.setToolActive("exec_command", false);
		const blockResult = pi.handlers.get("tool_call")?.[0]?.({ toolName: "exec_command" }, {});

		expect(pi.getActiveTools()).toEqual(["read"]);
		expect(blockResult).toEqual({
			block: true,
			reason: "exec_command is disabled by the token-burden extension. Toggle it on from /token-burden if needed.",
		});
	});

	test("persists disabled tool changes to config", () => {
		const configPath = join(mkdtempSync(join(tmpdir(), "token-burden-tools-")), "config.json");
		writeFileSync(configPath, `${JSON.stringify({ disabledTools: ["find"] })}\n`, "utf8");
		const pi = createPi(["read", "exec_command"], loadToolToggleConfig(configPath).disabledTools, configPath);

		pi.controller.setToolActive("functions.find", true);
		pi.controller.setToolActive("exec_command", false);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			disabledTools: ["exec_command"],
		});
	});

	test("loads an explicitly empty disabled tool list without restoring defaults", () => {
		const configPath = join(mkdtempSync(join(tmpdir(), "token-burden-tools-")), "config.json");
		writeFileSync(configPath, `${JSON.stringify({ disabledTools: [] })}\n`, "utf8");

		expect(loadToolToggleConfig(configPath)).toEqual({ disabledTools: [] });
	});
});
