import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import convergenceLoopExtension, { COMPLETION_MARKER } from "../convergence-loop";
import systemPromptExtension, { buildSystemPrompt } from "./index";

const baseOptions = {
	cwd: "/repo",
	skills: [
		{
			name: "tdd",
			description: "Apply test-driven development",
			filePath: "/skills/tdd/SKILL.md",
			baseDir: "/skills/tdd",
			sourceInfo: { path: "/skills/tdd/SKILL.md", source: "test", scope: "project", origin: "top-level" },
			disableModelInvocation: false,
		},
	],
};

describe("system-prompt Skillful skill rendering", () => {
	test("renders environment metadata as structured environment context", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			now: new Date(2026, 4, 10),
			environmentContext: {
				shell: "zsh",
				timezone: "America/New_York",
			},
		});

		expect(prompt).toContain(`<environment_context>
  <cwd>/repo</cwd>
  <shell>zsh</shell>
  <current_date>2026-05-10</current_date>
  <timezone>America/New_York</timezone>
</environment_context>`);
	});

	test("renders multiple environments with XML escaping", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			now: new Date(2026, 4, 10),
			environmentContext: {
				environments: [
					{ id: "local", cwd: "/repo & one", shell: "zsh" },
					{ id: `remote"two`, cwd: "/srv/<app>", shell: "bash" },
				],
				timezone: "Etc/UTC",
			},
		});

		expect(prompt).toContain(`<environments>
    <environment id="local">
      <cwd>/repo &amp; one</cwd>
      <shell>zsh</shell>
    </environment>
    <environment id="remote&quot;two">
      <cwd>/srv/&lt;app&gt;</cwd>
      <shell>bash</shell>
    </environment>
  </environments>`);
		expect(prompt).toContain("<timezone>Etc/UTC</timezone>");
	});

	test("renders contributed tool guidance once without inventing capabilities", () => {
		const guideline = "Use the fixture tool for its supported operation.";
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["fixture"],
			promptGuidelines: [guideline, `  ${guideline}  `, "", "  "],
		});

		expect(prompt.split(guideline)).toHaveLength(2);
		for (const unavailable of [
			"multi_tool_use.parallel",
			"sym --format",
			"spawn_lane",
			"apply_patch",
			"exec_command",
		]) {
			expect(prompt).not.toContain(unavailable);
		}
	});

	test("omits tool and documentation sections when no contributions exist", () => {
		const prompt = buildSystemPrompt("base", { cwd: "/repo", selectedTools: [] });
		expect(prompt).not.toContain("# Tool guidance");
		expect(prompt).not.toContain("# Pi documentation");
		expect(prompt).not.toContain("documentation: null");
	});

	test("preserves supplied documentation locations", () => {
		const prompt = buildSystemPrompt("- Main documentation: /opt/pi/README.md\n- Additional docs: /opt/pi/docs", {
			cwd: "/repo",
			selectedTools: [],
		});
		expect(prompt).toContain("/opt/pi/README.md");
		expect(prompt).toContain("/opt/pi/docs");
		expect(prompt).not.toContain("Examples: null");
	});

	test("custom prompts replace the base but preserve appended context and skills", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			customPrompt: "CUSTOM_PROMPT_SENTINEL",
			appendSystemPrompt: "APPEND_SENTINEL",
			contextFiles: [{ path: "/repo/AGENTS.md", content: "CONTEXT_SENTINEL" }],
		});
		for (const sentinel of ["CUSTOM_PROMPT_SENTINEL", "APPEND_SENTINEL", "CONTEXT_SENTINEL"]) {
			expect(prompt.split(sentinel)).toHaveLength(2);
		}
		expect(prompt).toContain("- tdd: Apply test-driven development");
		expect(prompt).toContain("<environment_context>");
		expect(prompt).not.toContain("# Working with the user");
	});

	test("explicit-only skills stay out of automatic discovery", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			skills: [{ ...baseOptions.skills[0], disableModelInvocation: true }],
		});
		expect(prompt).not.toContain("<available_skills>");
		expect(prompt).not.toContain("- tdd:");
	});

	test("skill tool active lists skills by name and description only", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["skill"],
		});

		expect(prompt).toContain("`skill({name})`");
		expect(prompt).toContain("- tdd: Apply test-driven development");
		expect(prompt).not.toContain("/skills/tdd/SKILL.md");
	});

	test("read fallback keeps skill locations", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["read"],
		});

		expect(prompt).toContain("Read the listed `SKILL.md`");
		expect(prompt).toContain("- tdd: Apply test-driven development (/skills/tdd/SKILL.md)");
	});

	test("composed skill loading keeps the catalog and names the executable tool path", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["exec", "wait", "tool_search"],
			composedTools: ["read", "skill"],
		});
		expect(prompt).toContain("- tdd: Apply test-driven development");
		expect(prompt).toContain("`tools.skill({name})` inside `exec`");
		expect(prompt).not.toContain("/skills/tdd/SKILL.md");
	});

	test("omits skills when no loading tool is active", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: [],
		});

		expect(prompt).not.toContain("<available_skills>");
		expect(prompt).not.toContain("- tdd: Apply test-driven development");
	});

	test("renders context files contributed through system prompt options", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: [],
			contextFiles: [{ path: "/repo/CLAUDE.local.md", content: "LOCAL_SENTINEL" }],
		});

		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## /repo/CLAUDE.local.md");
		expect(prompt).toContain("LOCAL_SENTINEL");
	});
});

test("configured handler order preserves per-turn loop instructions", async () => {
	const settings = JSON.parse(readFileSync(new URL("../../settings.json", import.meta.url), "utf8"));
	const handlers: Array<(event: any, ctx: any) => any> = [];
	const commands = new Map<string, any>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => any) {
			if (name === "before_agent_start") handlers.push(handler);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	const contributors: Record<string, (pi: ExtensionAPI) => unknown> = {
		"extensions/system-prompt/index.ts": systemPromptExtension,
		"extensions/convergence-loop/index.ts": convergenceLoopExtension,
	};
	for (const extension of settings.extensions) {
		if (contributors[extension]) await contributors[extension](pi);
	}
	expect(handlers).toHaveLength(2);
	const ctx = {
		cwd: "/repo",
		isIdle: () => true,
		ui: { setStatus() {}, notify() {} },
	};
	const options = {
		cwd: ctx.cwd,
		selectedTools: [],
		appendSystemPrompt: "APPEND_SENTINEL",
		contextFiles: [{ path: "/repo/AGENTS.local.md", content: "LOCAL_SENTINEL" }],
	};
	const renderTurn = async () => {
		let systemPrompt = "native base";
		for (const handler of handlers) {
			const result = await handler({ systemPrompt, systemPromptOptions: options }, ctx);
			if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
		}
		return systemPrompt;
	};

	await commands.get("goal").handler("--max 3 repair the parser", ctx);
	for (let turn = 0; turn < 2; turn++) {
		const prompt = await renderTurn();
		expect(prompt).toContain("repair the parser");
		expect(prompt).toContain("iteration 1 of 3");
		expect(prompt).toContain(COMPLETION_MARKER);
		for (const sentinel of ["APPEND_SENTINEL", "LOCAL_SENTINEL", "repair the parser"]) {
			expect(prompt.split(sentinel)).toHaveLength(2);
		}
	}
	await commands.get("goal").handler("stop", ctx);
	expect(await renderTurn()).not.toContain(COMPLETION_MARKER);
	expect(options.appendSystemPrompt).toBe("APPEND_SENTINEL");
});
