import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../system-prompt";
import { parseSystemPrompt } from "./parser";

const skill = {
	name: "tdd",
	description: "Apply test-driven development",
	filePath: "/skills/tdd/SKILL.md",
	baseDir: "/skills/tdd",
	sourceInfo: { path: "/skills/tdd/SKILL.md", source: "test", scope: "project", origin: "top-level" },
	disableModelInvocation: false,
};

describe("token-burden system prompt parser", () => {
	test("detects Skillful-active skill entries without locations", () => {
		const prompt = buildSystemPrompt("base", {
			cwd: "/repo",
			selectedTools: ["skill"],
			skills: [skill],
		});

		const parsed = parseSystemPrompt(prompt);

		expect(parsed.skills).toEqual([
			{
				name: "tdd",
				description: "Apply test-driven development",
				location: "",
				chars: expect.any(Number),
				tokens: expect.any(Number),
			},
		]);
		expect(parsed.sections.some((section) => section.label === "Skills (1)")).toBe(true);
	});

	test("detects read-fallback skill entry locations", () => {
		const prompt = buildSystemPrompt("base", {
			cwd: "/repo",
			selectedTools: ["read"],
			skills: [skill],
		});

		const parsed = parseSystemPrompt(prompt);

		expect(parsed.skills[0]?.location).toBe("/skills/tdd/SKILL.md");
	});

	test("detects structured environment context as metadata footer", () => {
		const prompt = buildSystemPrompt("base", {
			cwd: "/repo",
			selectedTools: [],
			environmentContext: {
				shell: "zsh",
				timezone: "Etc/UTC",
			},
			now: new Date(2026, 4, 10),
		});

		const parsed = parseSystemPrompt(prompt);
		const metadata = parsed.sections.find((section) => section.label === "Metadata (environment context)");

		expect(metadata?.content).toStartWith("<environment_context>");
		expect(metadata?.content).toContain("<cwd>/repo</cwd>");
		expect(metadata?.content).toContain("<shell>zsh</shell>");
	});

	test("does not treat parenthesized descriptions as locations", () => {
		const prompt = [
			"base",
			"<skills_instructions>",
			"The following skills provide specialized instructions",
			"<available_skills>",
			"- fast: Apply test-driven development (quick mode)",
			"- local: Load a local skill (/skills/local/SKILL.md)",
			"</available_skills>",
			"</skills_instructions>",
			"",
			"Current date: 2026-05-10",
		].join("\n");

		const parsed = parseSystemPrompt(prompt);

		expect(parsed.skills).toEqual([
			{
				name: "fast",
				description: "Apply test-driven development (quick mode)",
				location: "",
				chars: expect.any(Number),
				tokens: expect.any(Number),
			},
			{
				name: "local",
				description: "Load a local skill",
				location: "/skills/local/SKILL.md",
				chars: expect.any(Number),
				tokens: expect.any(Number),
			},
		]);
	});
});
