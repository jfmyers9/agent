import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatToolSectionMarkdown,
	isBackKey,
	isForwardKey,
	isNavigateDownKey,
	isNavigateUpKey,
	showReport,
	wrapLegendParts,
} from "./report-view";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

describe("token burden vim key bindings", () => {
	test("maps vim movement keys to existing overlay actions", () => {
		expect(isNavigateUpKey("k")).toBe(true);
		expect(isNavigateDownKey("j")).toBe(true);
		expect(isForwardKey("l")).toBe(true);
		expect(isBackKey("h")).toBe(true);
		expect(isBackKey("q")).toBe(true);
	});

	test("does not treat unrelated printable keys as navigation", () => {
		expect(isNavigateUpKey("u")).toBe(false);
		expect(isNavigateDownKey("d")).toBe(false);
		expect(isForwardKey("f")).toBe(false);
		expect(isBackKey("b")).toBe(false);
	});
});

describe("token burden stacked legend", () => {
	test("wraps legend parts within the available row width", () => {
		const parts = [
			"■ Base 17.2%",
			"■ SYSTEM 0.0%",
			"■ AGENTS 9.4%",
			"■ Skills 11.9%",
			"■ Meta 0.2%",
			"■ Tools 61.2%",
		];

		const rows = wrapLegendParts(parts, 45);

		expect(rows.length).toBeGreaterThan(1);
		expect(rows.join("  ")).toBe(parts.join("  "));
		for (const row of rows) {
			expect(row.length).toBeLessThanOrEqual(45);
		}
	});

	test("renders combined burden plus session bars", async () => {
		let rendered = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {}, stop() {}, start() {} }, {}, {}, () => {});
					rendered = stripAnsi(component.render(80).join("\n"));
				},
			},
		};

		await showReport(
			{
				totalChars: 200,
				totalTokens: 100,
				skills: [],
				sections: [
					{ label: "Base prompt", chars: 80, tokens: 40 },
					{ label: "Tool definitions (1)", chars: 120, tokens: 60 },
				],
			},
			1000,
			ctx as any,
			[],
			undefined,
			undefined,
			undefined,
			{
				tokens: 50,
				estimated: false,
				categories: [
					{ label: "User prompts", tokens: 20 },
					{ label: "Assistant", tokens: 30 },
				],
			},
		);

		expect(rendered).toContain("Burden + session: 150 / 1,000 tokens");
		expect(rendered).toContain("Burden + session by category");
		expect(rendered).toContain("User 13.3%");
		expect(rendered).toContain("Assistant 20.0%");
	});

	test("sorts combined categories by token share descending", async () => {
		let rendered = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {}, stop() {}, start() {} }, {}, {}, () => {});
					rendered = stripAnsi(component.render(120).join("\n"));
				},
			},
		};

		await showReport(
			{
				totalChars: 250,
				totalTokens: 250,
				skills: [],
				sections: [
					{ label: "Base prompt", chars: 50, tokens: 50 },
					{ label: "Tool definitions (1)", chars: 200, tokens: 200 },
				],
			},
			1000,
			ctx as any,
			[],
			undefined,
			undefined,
			undefined,
			{
				tokens: 250,
				estimated: false,
				categories: [
					{ label: "Tool result: read", tokens: 150 },
					{ label: "Assistant", tokens: 100 },
				],
			},
		);

		const legendStart = rendered.indexOf("Tool defs 40.0%");
		const readIndex = rendered.indexOf("read 30.0%");
		const assistantIndex = rendered.indexOf("Assistant 20.0%");
		const baseIndex = rendered.indexOf("Base 10.0%");

		expect(legendStart).toBeGreaterThanOrEqual(0);
		expect(readIndex).toBeGreaterThan(legendStart);
		expect(assistantIndex).toBeGreaterThan(readIndex);
		expect(baseIndex).toBeGreaterThan(assistantIndex);
	});

	test("rotates colors across adjacent session categories", async () => {
		let rendered = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {}, stop() {}, start() {} }, {}, {}, () => {});
					rendered = component.render(120).join("\n");
				},
			},
		};

		await showReport(
			{
				totalChars: 100,
				totalTokens: 50,
				skills: [],
				sections: [{ label: "Base prompt", chars: 100, tokens: 50 }],
			},
			1000,
			ctx as any,
			[],
			undefined,
			undefined,
			undefined,
			{
				tokens: 60,
				estimated: false,
				categories: [
					{ label: "Tool result: exec_command(rg)", tokens: 30 },
					{ label: "Tool result: exec_command(bun)", tokens: 30 },
					{ label: "Tool result: read", tokens: 30 },
				],
			},
		);

		const execColor = rendered.match(/\x1b\[([0-9;]+)m■\x1b\[0m exec:rg/)?.[1];
		const bunColor = rendered.match(/\x1b\[([0-9;]+)m■\x1b\[0m exec:bun/)?.[1];
		const readColor = rendered.match(/\x1b\[([0-9;]+)m■\x1b\[0m read/)?.[1];

		expect(execColor).toBeDefined();
		expect(bunColor).toBeDefined();
		expect(readColor).toBeDefined();
		expect(execColor).not.toBe(readColor);
		expect(new Set([execColor, bunColor, readColor]).size).toBe(3);
	});

	test("renders readable compact labels for exec_command buckets", async () => {
		let rendered = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {}, stop() {}, start() {} }, {}, {}, () => {});
					rendered = stripAnsi(component.render(120).join("\n"));
				},
			},
		};

		await showReport(
			{
				totalChars: 100,
				totalTokens: 50,
				skills: [],
				sections: [{ label: "Base prompt", chars: 100, tokens: 50 }],
			},
			1000,
			ctx as any,
			[],
			undefined,
			undefined,
			undefined,
			{
				tokens: 20,
				estimated: false,
				categories: [{ label: "Tool result: exec_command(rg)", tokens: 20 }],
			},
		);

		expect(rendered).toContain("exec:rg");
		expect(rendered).not.toContain("exec_command(…");
	});
});

describe("token burden tools overlay", () => {
	test("formats active and inactive tool definitions as markdown", () => {
		const content = formatToolSectionMarkdown({
			active: [
				{
					name: "bash",
					chars: 20,
					tokens: 10,
					content: '{"name":"bash","description":"Run a shell command","parameters":{"type":"object"}}',
				},
			],
			inactive: [
				{
					name: "find",
					chars: 20,
					tokens: 10,
					content: '{"name":"find","description":"Find text","parameters":{"type":"object"}}',
				},
			],
		});

		expect(content).toContain("# Tool definitions");
		expect(content).toContain("## Active tools");
		expect(content).toContain("### bash (10 tokens)");
		expect(content).toContain("Run a shell command");
		expect(content).toContain("#### Parameters");
		expect(content).toContain('"type": "object"');
		expect(content).toContain("## Inactive tools");
		expect(content).toContain("### find (10 tokens)");
	});

	test("opens the whole tool section from the top-level view", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "token-burden-view-"));
		const editorScript = join(tmp, "editor.cjs");
		const openedPathFile = join(tmp, "opened-path");
		const oldEditor = process.env.EDITOR;
		const oldVisual = process.env.VISUAL;

		writeFileSync(
			editorScript,
			[
				"const { writeFileSync } = require('node:fs');",
				`writeFileSync(${JSON.stringify(openedPathFile)}, process.argv.at(-1));`,
			].join("\n"),
			"utf8",
		);

		try {
			delete process.env.VISUAL;
			process.env.EDITOR = `${process.execPath} ${editorScript}`;

			const ctx = {
				ui: {
					custom: async (factory: any) => {
						const component = factory({ requestRender() {}, stop() {}, start() {} }, {}, {}, () => {});
						component.handleInput("e");
					},
				},
			};

			await showReport(
				{
					totalChars: 20,
					totalTokens: 10,
					skills: [],
					sections: [
						{
							label: "Tool definitions (1 active, 2 total)",
							chars: 20,
							tokens: 10,
							tools: {
								active: [
									{
										name: "bash",
										chars: 20,
										tokens: 10,
										content: '{"name":"bash","description":"Run a shell command"}',
									},
								],
								inactive: [
									{
										name: "find",
										chars: 20,
										tokens: 10,
										content: '{"name":"find","description":"Find text"}',
									},
								],
							},
							children: [{ label: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
						},
					],
				},
				100,
				ctx as any,
			);

			const openedPath = readFileSync(openedPathFile, "utf8");
			expect(openedPath.endsWith(".md")).toBe(true);
			const openedContent = readFileSync(openedPath, "utf8");
			expect(openedContent).toContain("# Tool definitions");
			expect(openedContent).toContain("### bash (10 tokens)");
			expect(openedContent).toContain("Run a shell command");
			expect(openedContent).toContain("### find (10 tokens)");
			expect(openedContent).toContain("Find text");
		} finally {
			if (oldEditor === undefined) {
				delete process.env.EDITOR;
			} else {
				process.env.EDITOR = oldEditor;
			}
			if (oldVisual === undefined) {
				delete process.env.VISUAL;
			} else {
				process.env.VISUAL = oldVisual;
			}
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("opens the selected tool as markdown with token cost in the title", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "token-burden-view-tool-"));
		const editorScript = join(tmp, "editor.cjs");
		const openedPathFile = join(tmp, "opened-path");
		const oldEditor = process.env.EDITOR;
		const oldVisual = process.env.VISUAL;

		writeFileSync(
			editorScript,
			[
				"const { writeFileSync } = require('node:fs');",
				`writeFileSync(${JSON.stringify(openedPathFile)}, process.argv.at(-1));`,
			].join("\n"),
			"utf8",
		);

		try {
			delete process.env.VISUAL;
			process.env.EDITOR = `${process.execPath} ${editorScript}`;

			const ctx = {
				ui: {
					custom: async (factory: any) => {
						const component = factory({ requestRender() {}, stop() {}, start() {} }, {}, {}, () => {});
						component.handleInput("l");
						component.handleInput("e");
					},
				},
			};

			await showReport(
				{
					totalChars: 20,
					totalTokens: 10,
					skills: [],
					sections: [
						{
							label: "Tool definitions (1 active, 1 total)",
							chars: 20,
							tokens: 10,
							tools: {
								active: [
									{
										name: "bash",
										chars: 20,
										tokens: 10,
										content: '{"name":"bash","description":"Run a shell command"}',
									},
								],
								inactive: [],
							},
							children: [{ label: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
						},
					],
				},
				100,
				ctx as any,
			);

			const openedPath = readFileSync(openedPathFile, "utf8");
			expect(openedPath.endsWith(".md")).toBe(true);
			const openedContent = readFileSync(openedPath, "utf8");
			expect(openedContent).toContain("## bash (10 tokens)");
			expect(openedContent).toContain("Run a shell command");
		} finally {
			if (oldEditor === undefined) {
				delete process.env.EDITOR;
			} else {
				process.env.EDITOR = oldEditor;
			}
			if (oldVisual === undefined) {
				delete process.env.VISUAL;
			} else {
				process.env.VISUAL = oldVisual;
			}
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("renders tool toggle states with skill-style icons", async () => {
		let rendered = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					rendered = stripAnsi(component.render(80).join("\n"));
				},
			},
		};

		await showReport(
			{
				totalChars: 20,
				totalTokens: 10,
				skills: [],
				sections: [
					{
						label: "Tool definitions (1 active, 2 total)",
						chars: 20,
						tokens: 10,
						tools: {
							active: [{ name: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
							inactive: [{ name: "find", chars: 20, tokens: 10, content: '{"name":"find"}' }],
						},
						children: [{ label: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
						drillable: true,
					} as any,
				],
			},
			100,
			ctx as any,
		);

		expect(rendered).toContain("▸ ●  bash");
		expect(rendered).toContain("· ○  find");
		expect(rendered).toContain("● on  ◐ mixed group  ○ disabled");
		expect(rendered).not.toContain("Inactive (");
	});

	test("groups Codex Apps tools by app with aggregate toggle state", async () => {
		let rendered = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					rendered = stripAnsi(component.render(100).join("\n"));
				},
			},
		};

		await showReport(
			{
				totalChars: 60,
				totalTokens: 30,
				skills: [],
				sections: [
					{
						label: "Tool definitions (2 active, 4 total)",
						chars: 60,
						tokens: 30,
						tools: {
							active: [
								{ name: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' },
								{
									name: "codex_apps_github_list_repositories",
									chars: 20,
									tokens: 10,
									content:
										'{"name":"codex_apps_github_list_repositories","description":"List repositories.\\n\\nCodex app: GitHub."}',
								},
							],
							inactive: [
								{
									name: "codex_apps_github_create_issue",
									chars: 20,
									tokens: 10,
									content:
										'{"name":"codex_apps_github_create_issue","description":"Create an issue.\\n\\nCodex app: GitHub."}',
								},
								{
									name: "codex_apps_slack_slack_read_channel",
									chars: 20,
									tokens: 10,
									content:
										'{"name":"codex_apps_slack_slack_read_channel","description":"Read a channel.\\n\\nCodex app: Slack."}',
								},
							],
						},
						children: [],
						drillable: true,
					} as any,
				],
			},
			100,
			ctx as any,
		);

		expect(rendered).toContain("· ◐  ▾ Codex Apps / GitHub");
		expect(rendered).toContain("1/2 on");
		expect(rendered).toContain("·   ○  create_issue");
		expect(rendered).toContain("·   ●  list_repositories");
		expect(rendered).toContain("· ○  ▾ Codex Apps / Slack");
		expect(rendered).toContain("·   ○  read_channel");
		expect(rendered).not.toContain("codex_apps_github");
		expect(rendered).not.toContain("codex_apps_slack");
	});

	test("collapses and expands Codex Apps groups with enter", async () => {
		let collapsed = "";
		let expanded = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					component.handleInput("l");
					collapsed = stripAnsi(component.render(100).join("\n"));
					component.handleInput("l");
					expanded = stripAnsi(component.render(100).join("\n"));
				},
			},
		};

		await showReport(
			{
				totalChars: 40,
				totalTokens: 20,
				skills: [],
				sections: [
					{
						label: "Tool definitions (1 active, 2 total)",
						chars: 20,
						tokens: 10,
						tools: {
							active: [
								{
									name: "codex_apps_github_list_repositories",
									chars: 20,
									tokens: 10,
									content:
										'{"name":"codex_apps_github_list_repositories","description":"List repositories.\\n\\nCodex app: GitHub."}',
								},
							],
							inactive: [
								{
									name: "codex_apps_github_create_issue",
									chars: 20,
									tokens: 10,
									content:
										'{"name":"codex_apps_github_create_issue","description":"Create an issue.\\n\\nCodex app: GitHub."}',
								},
							],
						},
						children: [],
						drillable: true,
					} as any,
				],
			},
			100,
			ctx as any,
		);

		expect(collapsed).toContain("▸ ◐  ▸ Codex Apps / GitHub");
		expect(collapsed).not.toContain("create_issue");
		expect(collapsed).not.toContain("list_repositories");
		expect(expanded).toContain("▸ ◐  ▾ Codex Apps / GitHub");
		expect(expanded).toContain("·   ○  create_issue");
		expect(expanded).toContain("·   ●  list_repositories");
	});

	test("toggles a Codex Apps group by applying the target state to tools in that app", async () => {
		const calls: Array<{ toolName: string; enabled: boolean }> = [];
		let activeToolNames = ["codex_apps_github_list_repositories"];
		let renderedAfterToggle = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					component.handleInput(" ");
					renderedAfterToggle = stripAnsi(component.render(100).join("\n"));
				},
			},
		};

		await showReport(
			{
				totalChars: 40,
				totalTokens: 20,
				skills: [],
				sections: [
					{
						label: "Tool definitions (1 active, 2 total)",
						chars: 20,
						tokens: 10,
						tools: {
							active: [
								{
									name: "codex_apps_github_list_repositories",
									chars: 20,
									tokens: 10,
									content:
										'{"name":"codex_apps_github_list_repositories","description":"List repositories.\\n\\nCodex app: GitHub."}',
								},
							],
							inactive: [
								{
									name: "codex_apps_github_create_issue",
									chars: 20,
									tokens: 10,
									content:
										'{"name":"codex_apps_github_create_issue","description":"Create an issue.\\n\\nCodex app: GitHub."}',
								},
							],
						},
						children: [],
						drillable: true,
					} as any,
				],
			},
			100,
			ctx as any,
			[],
			undefined,
			undefined,
			(toolName, enabled) => {
				calls.push({ toolName, enabled });
				activeToolNames = enabled
					? [...new Set([...activeToolNames, toolName])]
					: activeToolNames.filter((name) => name !== toolName);
				return { applied: true, activeToolNames };
			},
		);

		expect(calls).toEqual([{ toolName: "codex_apps_github_create_issue", enabled: true }]);
		expect(renderedAfterToggle).toContain("▸ ●  ▾ Codex Apps / GitHub");
		expect(renderedAfterToggle).toContain("2/2 on");
		expect(renderedAfterToggle).toContain("·   ●  create_issue");
		expect(renderedAfterToggle).toContain("·   ●  list_repositories");
	});

	test("toggles the selected active tool through the supplied handler", async () => {
		const calls: Array<{ toolName: string; enabled: boolean }> = [];
		let renderedAfterToggle = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					component.handleInput(" ");
					renderedAfterToggle = component.render(80).join("\n");
				},
			},
		};

		await showReport(
			{
				totalChars: 20,
				totalTokens: 10,
				skills: [],
				sections: [
					{
						label: "Tool definitions (1 active, 2 total)",
						chars: 20,
						tokens: 10,
						tools: {
							active: [{ name: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
							inactive: [{ name: "find", chars: 20, tokens: 10, content: '{"name":"find"}' }],
						},
						children: [{ label: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
						drillable: true,
					} as any,
				],
			},
			100,
			ctx as any,
			[],
			undefined,
			undefined,
			(toolName, enabled) => {
				calls.push({ toolName, enabled });
				return { applied: true, activeToolNames: [] };
			},
		);

		expect(calls).toEqual([{ toolName: "bash", enabled: false }]);
		const stripped = stripAnsi(renderedAfterToggle);
		expect(stripped).toContain("▸ ○  bash");
		expect(stripped).toContain("· ○  find");
		expect(stripped).not.toContain("Active (0)");
		expect(stripped).not.toContain("Inactive (2");
	});
});
