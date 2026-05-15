import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import gitToolExtension, {
	appendGitToolPrompt,
	GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM,
	GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM,
	GIT_TOOL_MAIN_PROMPT_ADDENDUM,
	gitToolResources,
	gitToolToolCallBlock,
	parseGitToolMode,
} from "./index";

type Handler = (...args: any[]) => unknown;

function createPi(configValue: string | undefined) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};

	gitToolExtension(pi as any, {
		readGitToolConfig: () => configValue,
	});

	return { handlers };
}

function toolCall(toolName: string, command?: string) {
	return {
		toolName,
		input: command === undefined ? {} : { command },
	};
}

describe("git-tool mode parsing", () => {
	test.each([
		["graphite", "graphite"],
		["git-spice", "git-spice"],
		["main", "main"],
		["none", "none"],
		[undefined, "none"],
		["", "none"],
		[" Graphite ", "none"],
		["unknown", "none"],
	])("parses %p as %p", (input, expected) => {
		expect(parseGitToolMode(input)).toBe(expected);
	});
});

describe("git-tool resources", () => {
	test("graphite mode contributes exactly the Graphite generic skill directory", () => {
		const resources = gitToolResources("graphite");

		expect(resources.skillPaths?.map((path) => basename(path))).toEqual(["graphite"]);
		expect(resources.skillPaths?.[0]).toContain("git-tool/skill-resources/graphite");
	});

	test("git-spice mode contributes exactly the Git-Spice generic skill directory", () => {
		const resources = gitToolResources("git-spice");

		expect(resources.skillPaths?.map((path) => basename(path))).toEqual(["git-spice"]);
		expect(resources.skillPaths?.[0]).toContain("git-tool/skill-resources/git-spice");
	});

	test("main mode contributes no skill paths", () => {
		expect(gitToolResources("main")).toEqual({});
	});

	test("none mode contributes no skill paths", () => {
		expect(gitToolResources("none")).toEqual({});
	});
});

describe("git-tool prompt addendum", () => {
	test("graphite mode adds strict stack workflow guidance", () => {
		const prompt = appendGitToolPrompt("base", "graphite");

		expect(prompt).toContain(GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM);
		expect(prompt).toContain("Do not use raw `git push`");
		expect(prompt).toContain("Use the `submit`, `sync`, `restack`, and `stack` skills");
	});

	test("git-spice mode adds strict stack workflow guidance", () => {
		const prompt = appendGitToolPrompt("base", "git-spice");

		expect(prompt).toContain(GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM);
		expect(prompt).toContain("Do not use raw `git push`");
		expect(prompt).toContain("Use the `submit`, `sync`, `restack`, and `stack` skills");
	});

	test("main mode adds current-branch commit and push guidance", () => {
		const prompt = appendGitToolPrompt("base", "main");

		expect(prompt).toContain("base");
		expect(prompt).toContain(GIT_TOOL_MAIN_PROMPT_ADDENDUM);
		expect(prompt).toContain("currently checked-out branch");
	});

	test("main prompt addendum is idempotent", () => {
		const once = appendGitToolPrompt("base", "main");
		expect(appendGitToolPrompt(once, "main")).toBe(once);
	});

	test("graphite prompt addendum is idempotent", () => {
		const once = appendGitToolPrompt("base", "graphite");
		expect(appendGitToolPrompt(once, "graphite")).toBe(once);
	});

	test("git-spice prompt addendum is idempotent", () => {
		const once = appendGitToolPrompt("base", "git-spice");
		expect(appendGitToolPrompt(once, "git-spice")).toBe(once);
	});

	test("none mode leaves system prompt unchanged", () => {
		expect(appendGitToolPrompt("base", "none")).toBe("base");
	});
});

describe("Git-Spice skills", () => {
	test("exposes generic skill names only", () => {
		const skillDir = gitToolResources("git-spice").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Git-Spice skill directory");

		expect(skillDirectoryNames(skillDir)).toEqual(["restack", "stack", "submit", "sync"]);
	});

	test("documents Git-Spice branch creation commands and shorthands", () => {
		const skillDir = gitToolResources("git-spice").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Git-Spice skill directory");

		const stack = readFileSync(`${skillDir}/stack/SKILL.md`, "utf8");

		expect(stack).toContain("name: stack");
		expect(stack).toContain("gs branch create");
		expect(stack).toContain("gs bc");
		expect(stack).not.toContain("name: gs");
	});

	test("documents Git-Spice submit command contracts without requiring the binary", () => {
		const skillDir = gitToolResources("git-spice").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Git-Spice skill directory");

		const submit = readFileSync(`${skillDir}/submit/SKILL.md`, "utf8");

		expect(submit).toContain("gs stack submit");
		expect(submit).toContain("gs ss");
		expect(submit).toContain("update existing Change Requests");
		expect(submit).toContain("Skill(pr-descr)");
		expect(submit).toContain("update-only and create modes");
	});
});

describe("git-tool tool-call handling", () => {
	test.each([
		"apply_patch",
		"functions.apply_patch",
		"edit",
		"write",
		"exec_command",
		"bash",
		"functions.exec_command",
	])("allows %s", (toolName) => {
		expect(gitToolToolCallBlock(toolCall(toolName))).toBeUndefined();
	});
});

describe("Graphite skills", () => {
	test("exposes generic skill names only", () => {
		const skillDir = gitToolResources("graphite").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Graphite skill directory");

		expect(skillDirectoryNames(skillDir)).toEqual(["restack", "stack", "submit", "sync"]);
	});

	test("preserves Graphite submit safety rules", () => {
		const skillDir = gitToolResources("graphite").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Graphite skill directory");

		const submit = readFileSync(`${skillDir}/submit/SKILL.md`, "utf8");

		expect(submit).toContain("name: submit");
		expect(submit).toContain("gt ss -u");
		expect(submit).toContain("Default is `gt ss -u`");
		expect(submit).toContain("Skill(pr-descr)");
		expect(submit).toContain("This applies to `gt ss -u`, `gt submit`, and `gt ss`");
		expect(submit).not.toContain("name: gt-submit");
	});

	test("removes legacy Graphite skill resources", () => {
		expect(existsSync("pi/agent/graphite-skills")).toBe(false);
	});
});

describe("git-tool extension", () => {
	test("registers resource discovery using configured mode", () => {
		const { handlers } = createPi("main");

		expect(handlers.get("resources_discover")?.[0]?.({}, {})).toEqual({});
	});

	test("registers before_agent_start prompt injection for main mode", () => {
		const { handlers } = createPi("main");

		const result = handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, {});

		expect(result).toEqual({ systemPrompt: appendGitToolPrompt("base", "main") });
	});

	test("does not inject prompt for invalid mode", () => {
		const { handlers } = createPi("invalid");

		expect(handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, {})).toBeUndefined();
	});

	test("allows tool calls through the extension handler", () => {
		const { handlers } = createPi("graphite");

		expect(handlers.get("tool_call")?.[0]?.(toolCall("apply_patch"), {})).toBeUndefined();
	});
});

function skillDirectoryNames(skillDir: string): string[] {
	return readdirSync(skillDir)
		.filter((name) => statSync(`${skillDir}/${name}`).isDirectory())
		.sort();
}
