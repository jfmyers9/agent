import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./index";

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

	test("tool guidance adapts to active file and shell tools", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["read", "search", "find", "exec_command"],
		});

		expect(prompt).toContain("Use `read` for known file paths.");
		expect(prompt).toContain("Prefer `read` ranges/limits over shell `sed`, `cat`, `head`, or `tail`");
		expect(prompt).toContain("Use `search` for file-content matching");
		expect(prompt).toContain("Use `find` for file discovery by glob or path.");
		expect(prompt).toContain("Use `exec_command` for shell-only workflows");
		expect(prompt).toContain("rg -n -M 400 --max-columns-preview");
		expect(prompt).toContain("avoid `head` for line-length control");
		expect(prompt).toContain("Do not use shell commands for routine file reads, writes, or edits");
		expect(prompt).not.toContain("Use `bash` for shell-only workflows");
		expect(prompt).not.toContain("RTK");
		expect(prompt).not.toContain("rtk grep");
	});

	test("bash guidance remains available without exec_command", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["bash", "grep"],
		});

		expect(prompt).toContain("Use `bash` for shell-only workflows");
		expect(prompt).toContain("Use `grep` for file-content matching when `search` is not active.");
		expect(prompt).toContain("rg -n -M 400 --max-columns-preview");
		expect(prompt).not.toContain("Use `exec_command` for shell-only workflows");
	});

	test("editing guidance uses active edit tool instead of hard-coded apply_patch", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: [],
		});

		expect(prompt).toContain("Use the active edit tool for manual code edits.");
		expect(prompt).toContain("active edit tool is enough");
		expect(prompt).not.toContain("Use `apply_patch` for manual code edits");
	});

	test("skill tool active lists skills by name and description only", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["skill"],
		});

		expect(prompt).toContain("The following skills provide specialized instructions");
		expect(prompt).toContain("call `skill({name})`");
		expect(prompt).toContain('matching `<skill name="...">` block is already in context');
		expect(prompt).toContain("- tdd: Apply test-driven development");
		expect(prompt).not.toContain("/skills/tdd/SKILL.md");
	});

	test("read fallback keeps skill locations", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["read"],
		});

		expect(prompt).toContain("read the referenced `SKILL.md` file");
		expect(prompt).toContain("- tdd: Apply test-driven development (/skills/tdd/SKILL.md)");
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
