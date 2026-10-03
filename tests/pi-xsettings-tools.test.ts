// Backported from luan/agents cda660ee; exercises the installed patched dependency.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createToolToggleController } from "../harnesses/pi/extensions/token-burden/tool-toggles.ts";
import xsettings from "../node_modules/@luan.sh/pi-xsettings/src/extension.ts";

interface SelectionCase {
	name: string;
	defaultTools: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: "all";
	disabledTools?: string[];
	expected: string[];
	reloaded: string[];
}

const cases: SelectionCase[] = [
	{
		name: "configured baseline",
		defaultTools: ["codemode", "fixture"],
		expected: ["codemode", "fixture"],
		reloaded: ["codemode", "extra", "fixture"],
	},
	{
		name: "relative selection",
		defaultTools: ["+codemode", "+fixture", "-bash", "-read", "-edit", "-write"],
		expected: ["codemode", "fixture"],
		reloaded: ["codemode", "extra", "fixture"],
	},
	{
		name: "tool allowlist",
		defaultTools: ["codemode", "fixture"],
		tools: ["fixture"],
		expected: ["fixture"],
		reloaded: ["fixture"],
	},
	{
		name: "excluded tool",
		defaultTools: ["codemode", "fixture"],
		excludeTools: ["fixture"],
		expected: ["codemode"],
		reloaded: ["codemode", "extra"],
	},
	{
		name: "persistently disabled by token-burden",
		defaultTools: ["codemode", "fixture"],
		disabledTools: ["fixture"],
		expected: ["codemode"],
		reloaded: ["codemode", "extra"],
	},
	{ name: "all tools disabled", defaultTools: ["codemode", "fixture"], noTools: "all", expected: [], reloaded: [] },
	{ name: "unknown configured tool", defaultTools: ["missing"], expected: [], reloaded: ["extra", "fixture"] },
	{ name: "empty configured selection", defaultTools: [], expected: [], reloaded: ["extra", "fixture"] },
];

test.each(cases)("tool baseline survives startup, reload and navigation: $name", async (selection) => {
	const root = await mkdtemp(join(tmpdir(), "pi-xsettings-selection-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		await writeFile(
			join(root, "settings.json"),
			JSON.stringify({ defaultTools: selection.defaultTools, codemode: { mode: "only" } }),
		);
		const settingsManager = SettingsManager.create(root, root, { projectTrusted: false });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(root, "models.json"),
			refreshOnCreate: false,
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			extensionFactories: [
				{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
				xsettings,
				(pi) => {
					// Match runtime-support before token-burden in the real extension list.
					if (selection.disabledTools) createToolToggleController(pi, selection.disabledTools).install();
					for (const name of ["fixture", "extra"]) {
						pi.registerTool({
							name,
							label: name,
							description: "Fixture tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [], details: {} }),
						});
					}
				},
			],
		});
		await resourceLoader.reload();
		const manager = SessionManager.inMemory(root);
		const emptyBranch = manager.appendMessage({ role: "system", content: "", toolsAdded: [], timestamp: 1 });
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			settingsManager,
			modelRuntime,
			resourceLoader,
			sessionManager: manager,
			tools: selection.tools,
			excludeTools: selection.excludeTools,
			noTools: selection.noTools,
		});
		try {
			const errors: string[] = [];
			session.setActiveToolsByName([]);
			await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
			expect(session.getActiveToolNames().sort()).toEqual(selection.expected);
			// Existing XSettings patch must continue preserving native settings it does not own.
			expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
				defaultTools: selection.defaultTools,
				codemode: { mode: "only" },
			});
			session.setActiveToolsByName([]);
			expect(session.getCallableToolNames()).not.toContain("fixture");
			const messages = [...session.messages];
			await session.reload();
			expect(errors).toEqual([]);
			expect(session.getActiveToolNames().sort()).toEqual(selection.reloaded);
			expect(session.getCallableToolNames().includes("fixture")).toBe(selection.reloaded.includes("fixture"));
			expect(session.messages).toEqual(messages);
			await session.navigateTree(emptyBranch, { summarize: false });
			expect(session.getActiveToolNames().sort()).toEqual(selection.expected);
			expect(session.getCallableToolNames().includes("fixture")).toBe(selection.expected.includes("fixture"));
			session.setActiveToolsByName(["extra"]);
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(selection.reloaded);
			if (selection.disabledTools) {
				const result = await session.extensionRunner?.emitToolCall({
					type: "tool_call",
					toolName: "fixture",
					toolCallId: "disabled-fixture",
					input: {},
				});
				expect(result?.block).toBe(true);
			}
		} finally {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
