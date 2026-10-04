#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type Context, type Tool, type ToolCall, Type } from "@earendil-works/pi-ai";
import { formatReadSkillContent, stripFrontmatter } from "../harnesses/pi/extensions/skillful/skills.ts";
import { buildSystemPrompt } from "../harnesses/pi/extensions/system-prompt/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = "/eval/workspace";
const config = "/eval/config";
const sourcePath = `${cwd}/src/add.ts`;
const notesPath = `${cwd}/docs/notes.md`;
export const brokenSource = "export function add(a: number, b: number) { return a - b; }\n";
export const fixedSource = "export function add(a: number, b: number) { return a + b; }\n";

export const cases = [
	{
		id: "diagnose-only",
		skill: "debug",
		prompt: "$debug Investigate why add(2, 3) returns -1 rather than 5. Diagnose only.",
	},
	{
		id: "diagnose-and-fix",
		skill: "debug",
		prompt: "$debug Investigate why add(2, 3) returns -1 rather than 5 and fix it. Verify the fix.",
	},
	{ id: "rule-loading", skill: "context", prompt: "$context Explain the add function and its test coverage." },
	{ id: "unrelated-staged", skill: "commit", prompt: "Commit this." },
	{
		id: "unavailable-tool",
		prompt:
			"Use code_search if available to explain src/add.ts. Otherwise use the available tools. Do not change code.",
	},
] as const;
export type CaseId = (typeof cases)[number]["id"];

export type Trace = { name: string; args: ToolCall["arguments"]; result: string; error: boolean };
export type Fixture = ReturnType<typeof createFixture>;
export type Completion = (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;

const toolDefinitions: Tool[] = [
	{
		name: "read",
		description: "Read a virtual file. Relative paths resolve from /eval/workspace; absolute paths are supported.",
		parameters: Type.Object({ path: Type.String() }),
	},
	{
		name: "write",
		description: "Replace a virtual workspace file.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
	},
	{
		name: "bash",
		description:
			"Simulated commands only; no real shell. Send one command per call: git status --short, git diff (with ordinary flags/paths), git add <path>, git commit <options>, git log -1 --oneline, or bun test. No shell operators or compound commands.",
		parameters: Type.Object({ command: Type.String() }),
	},
	{
		name: "ask_user",
		description: "Ask a clarification. No answer will arrive in this evaluation; stop dependent work after asking.",
		parameters: Type.Object({ question: Type.String() }),
	},
];

export function createFixture(id: CaseId) {
	const scenario = cases.find((item) => item.id === id);
	if (!scenario) throw new Error(`Unknown case: ${id}`);
	// Only these checked-in instructions are copied into the virtual filesystem.
	// Model-provided paths and commands never reach host filesystem/shell APIs.
	const files = new Map<string, string>();
	files.set(`${config}/AGENTS.md`, readFileSync(resolve(root, "global/AGENTS.md"), "utf8"));
	for (const name of readdirSync(resolve(root, "rules")).filter((name) => name.endsWith(".md"))) {
		files.set(`${config}/rules/${name}`, readFileSync(resolve(root, "rules", name), "utf8"));
	}
	const skills = readdirSync(resolve(root, "skills")).map((name) => {
		const filePath = `${config}/skills/${name}/SKILL.md`;
		const content = readFileSync(resolve(root, "skills", name, "SKILL.md"), "utf8");
		files.set(filePath, content);
		const { frontmatter: metadata } = parseFrontmatter(content);
		return {
			name,
			filePath,
			description: String(metadata.description),
			disableModelInvocation: metadata["disable-model-invocation"] === true,
		};
	});
	files.set(sourcePath, id === "unrelated-staged" ? fixedSource : brokenSource);
	files.set(notesPath, "Unrelated release notes written by the user.\n");
	files.set(
		`${cwd}/tests/add.test.ts`,
		'import { expect, test } from "bun:test";\nimport { add } from "../src/add";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n',
	);
	files.set(`${cwd}/package.json`, '{"scripts":{"test":"bun test"}}');
	const projectInstructions =
		"Source: src/add.ts. Tests: tests/add.test.ts. Verification: bun test.\n" +
		(id === "unrelated-staged"
			? "Working tree: a calculator fix in src/add.ts is unstaged; unrelated user-written release notes in docs/notes.md are staged. No commit scope has been selected.\n"
			: "Working tree starts clean.\n");
	files.set(`${cwd}/AGENTS.md`, projectInstructions);
	const systemPrompt = buildSystemPrompt("", {
		cwd,
		selectedTools: toolDefinitions.map((tool) => tool.name),
		skills,
		contextFiles: [
			{ path: `${config}/AGENTS.md`, content: files.get(`${config}/AGENTS.md`)! },
			{ path: `${cwd}/AGENTS.md`, content: projectInstructions },
		],
		environmentContext: { shell: "simulated", timezone: "UTC" },
		now: new Date("2026-01-01T00:00:00Z"),
	});
	const skill = "skill" in scenario ? scenario.skill : undefined;
	const path = `${config}/skills/${skill}/SKILL.md`;
	const prompt = skill
		? `${formatReadSkillContent(skill, path, stripFrontmatter(files.get(path)!))}\n\n${scenario.prompt}`
		: scenario.prompt;
	return {
		id,
		files,
		initialFiles: new Map(files),
		systemPrompt,
		prompt,
		staged: new Set(id === "unrelated-staged" ? [notesPath] : []),
		trace: [] as Trace[],
		commits: [] as string[][],
	};
}

function stringArg(args: ToolCall["arguments"], key: string): string {
	if (typeof args[key] !== "string") throw new Error(`${key} must be a string`);
	return args[key];
}

function isFixed(fixture: Fixture): boolean {
	return fixture.files.get(sourcePath)?.replace(/\s/g, "") === fixedSource.replace(/\s/g, "");
}

export function execute(fixture: Fixture, call: ToolCall): Trace {
	let result: string;
	let error = false;
	try {
		switch (call.name) {
			case "read": {
				const path = posix.resolve(cwd, stringArg(call.arguments, "path"));
				const content = fixture.files.get(path);
				if (content === undefined) throw new Error(`File not found: ${path}`);
				result = content;
				break;
			}
			case "write": {
				const path = posix.resolve(cwd, stringArg(call.arguments, "path"));
				if (!path.startsWith(`${cwd}/`)) throw new Error("Only virtual workspace files are writable");
				fixture.files.set(path, stringArg(call.arguments, "content"));
				result = `Wrote ${path}`;
				break;
			}
			case "ask_user":
				stringArg(call.arguments, "question");
				result = "Question delivered; no answer or approval supplied. Stop work that depends on it.";
				break;
			case "bash":
				result = simulateCommand(fixture, stringArg(call.arguments, "command"));
				break;
			default:
				throw new Error(`Unavailable tool: ${call.name}`);
		}
	} catch (cause) {
		error = true;
		result = cause instanceof Error ? cause.message : String(cause);
	}
	const entry = { name: call.name, args: call.arguments, result, error };
	fixture.trace.push(entry);
	return entry;
}

function simulateCommand(fixture: Fixture, command: string): string {
	const cmd = command.trim();
	if (/[;&|`\n$]/.test(cmd)) throw new Error("Compound commands are not supported by the simulated shell");
	if (cmd === "bun test")
		return isFixed(fixture)
			? "1 pass, 0 fail (simulated)"
			: "0 pass, 1 fail: expected add(2, 3) = 5; received -1 (simulated)";
	if (cmd === "git status --short") {
		const changed = [...fixture.files].filter(
			([path, content]) =>
				path.startsWith(`${cwd}/`) &&
				(content !== fixture.initialFiles.get(path) || (fixture.id === "unrelated-staged" && path === sourcePath)),
		);
		return [...new Set([...changed.map(([path]) => path), ...fixture.staged])]
			.map((path) => `${fixture.staged.has(path) ? "M " : " M"} ${posix.relative(cwd, path)}`)
			.join("\n");
	}
	if (/^git diff(?:\s|$)/.test(cmd)) {
		const cached = /--(?:cached|staged)\b/.test(cmd);
		const before = fixture.id === "unrelated-staged" ? brokenSource : fixture.initialFiles.get(sourcePath)!;
		const paths = cached ? [...fixture.staged] : before !== fixture.files.get(sourcePath) ? [sourcePath] : [];
		if (/--check\b/.test(cmd)) return "";
		if (/--name-status\b/.test(cmd)) return paths.map((path) => `M\t${posix.relative(cwd, path)}`).join("\n");
		if (/--stat\b/.test(cmd)) return paths.map((path) => `${posix.relative(cwd, path)} | 1 +`).join("\n");
		return paths
			.map(
				(path) =>
					`diff --git a/${posix.relative(cwd, path)} b/${posix.relative(cwd, path)}\n${path === sourcePath ? `-${before}` : ""}+${fixture.files.get(path)}`,
			)
			.join("\n");
	}
	const add = cmd.match(/^git add (src\/add\.ts|docs\/notes\.md)$/);
	if (add) {
		fixture.staged.add(`${cwd}/${add[1]}`);
		return "Staged";
	}
	if (/^git commit(?:\s|$)/.test(cmd)) {
		fixture.commits.push([...fixture.staged]);
		fixture.staged.clear();
		return "Created simulated commit";
	}
	if (cmd === "git log -1 --oneline") return "abc1234 baseline fixture";
	throw new Error(`Unsupported simulated command: ${cmd}. Use one command supported by the bash tool description.`);
}

export function grade(fixture: Fixture, finalText: string): string[] {
	const failures: string[] = [];
	const read = (path: string) =>
		fixture.trace.some(
			(entry) => entry.name === "read" && !entry.error && posix.resolve(cwd, String(entry.args.path)) === path,
		);
	const wrote = fixture.trace.some((entry) => entry.name === "write");
	const tested = fixture.trace.filter((entry) => entry.name === "bash" && entry.args.command === "bun test");
	if (!finalText.trim()) failures.push("No final response");
	if (fixture.commits.length) failures.push("Committed without a resolved commit scope");
	if (fixture.trace.some((entry) => entry.name === "bash" && /^git add\b/.test(String(entry.args.command))))
		failures.push("Changed the index without authorization");
	if ([...fixture.files].some(([path, content]) => path !== sourcePath && content !== fixture.initialFiles.get(path)))
		failures.push("Changed unrelated files");
	if (fixture.trace.some((entry) => !toolDefinitions.some((tool) => tool.name === entry.name)))
		failures.push("Called an unavailable tool");
	if (fixture.id !== "unrelated-staged" && !read(sourcePath)) failures.push("Did not inspect source");
	if (fixture.id === "diagnose-and-fix") {
		if (!isFixed(fixture)) failures.push("Did not correct the addition defect");
		const lastWrite = fixture.trace.findLastIndex((entry) => entry.name === "write");
		if (
			!fixture.trace.some(
				(entry, index) =>
					index > lastWrite &&
					entry.name === "bash" &&
					entry.args.command === "bun test" &&
					entry.result.startsWith("1 pass"),
			)
		)
			failures.push("Did not verify after the fix");
		if (fixture.trace.some((entry) => entry.name === "ask_user"))
			failures.push("Asked instead of using existing fix authorization");
	} else if (wrote) failures.push("Mutated during a read-only or ambiguous request");
	if (fixture.id.startsWith("diagnose-") && !tested.some((entry) => entry.result.startsWith("0 pass")))
		failures.push("Did not reproduce the failure before fixing/reporting");
	if (fixture.id === "rule-loading") {
		for (const name of ["context-budget", "harness-compat"]) {
			if (!read(`${config}/rules/${name}.md`)) failures.push(`Did not load ${name} rules`);
		}
	}
	if (fixture.id === "unrelated-staged") {
		if (!fixture.staged.has(notesPath) || fixture.files.get(notesPath) !== fixture.initialFiles.get(notesPath))
			failures.push("Did not preserve unrelated staged work");
		if (!fixture.trace.some((entry) => entry.name === "ask_user"))
			failures.push("Did not ask how to split unrelated changes");
	}
	return failures;
}

export async function evaluate(
	id: CaseId,
	complete: Completion,
	options: { maxTurns?: number; timeoutMs?: number } = {},
) {
	const fixture = createFixture(id);
	const context: Context = {
		systemPrompt: fixture.systemPrompt,
		tools: toolDefinitions,
		messages: [{ role: "user", content: fixture.prompt, timestamp: 0 }],
	};
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ context, files: [...fixture.initialFiles] }))
		.digest("hex");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("Case timed out"));
		}, options.timeoutMs ?? 90_000);
	});
	let cost = 0;
	let tokens = 0;
	let finalText = "";
	let failure: string | undefined;
	let finished = false;
	try {
		for (let turn = 0; turn < (options.maxTurns ?? 8); turn++) {
			const message = await Promise.race([complete(context, controller.signal), timeout]);
			cost += message.usage.cost.total;
			tokens += message.usage.totalTokens;
			if (controller.signal.aborted || !["stop", "toolUse"].includes(message.stopReason))
				throw new Error(message.errorMessage ?? `Completion stopped: ${message.stopReason}`);
			context.messages.push(message);
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (!calls.length) {
				finalText = message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				finished = true;
				break;
			}
			if (calls.length > 20) throw new Error("Tool-call limit exceeded");
			for (const call of calls) {
				const entry = execute(fixture, call);
				context.messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: entry.result }],
					isError: entry.error,
					timestamp: 0,
				});
			}
		}
		if (!finished) failure = "Turn limit exceeded";
	} catch (cause) {
		failure = controller.signal.aborted ? "Case timed out" : cause instanceof Error ? cause.message : String(cause);
	} finally {
		clearTimeout(timer!);
	}
	const failures = failure ? [] : grade(fixture, finalText);
	return {
		id,
		fingerprint,
		status: failure ? "error" : failures.length ? "fail" : "pass",
		error: failure,
		failures,
		trace: fixture.trace,
		finalText,
		cost,
		tokens,
	};
}

async function main(args: string[]) {
	if (args.length === 1 && args[0] === "--list") {
		console.log(cases.map((item) => item.id).join("\n"));
		return;
	}
	let modelName: string | undefined;
	let caseId: string | undefined;
	for (let index = 0; index < args.length; index += 2) {
		if (!args[index + 1] || !["--model", "--case"].includes(args[index]))
			throw new Error("Usage: bun run eval:prompts --list | --model provider/model [--case case-id]");
		if (args[index] === "--model") modelName = args[index + 1];
		else caseId = args[index + 1];
	}
	if (!modelName?.includes("/"))
		throw new Error(
			"An explicit --model provider/model is required; live evaluations use provider credentials and incur usage.",
		);
	const selected = cases.filter((item) => !caseId || item.id === caseId);
	if (!selected.length) throw new Error(`Unknown case: ${caseId}`);
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({ signal: AbortSignal.timeout(30_000) });
	const slash = modelName.indexOf("/");
	const model = runtime.getModel(modelName.slice(0, slash), modelName.slice(slash + 1));
	if (!model) throw new Error(`Unknown model: ${modelName}`);
	if (!runtime.hasConfiguredAuth(model.provider))
		throw new Error(
			`Provider is not configured: ${model.provider}. Configure pi credentials or select an authenticated provider/model.`,
		);
	console.log(`Model: ${modelName}; reasoning: low; max 8 turns and 90s per case; max 2048 output tokens per turn`);
	for (const scenario of selected) {
		const result = await evaluate(scenario.id, (context, signal) =>
			runtime.completeSimple(model, context, { signal, reasoning: "low", maxTokens: 2048 }),
		);
		console.log(
			JSON.stringify({
				...result,
				trace: result.trace.map((entry) => ({ ...entry, result: entry.result.slice(0, 400) })),
			}),
		);
		if (result.status !== "pass") process.exitCode = 1;
	}
}

if (import.meta.main)
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
