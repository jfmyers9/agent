import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSessionRuntime,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Point at a prebuilt host so ordinary unit tests never compile native code.
test.skipIf(!process.env.PI_CODE_MODE_HOST_BINARY)(
	"installed extensions compose local tools and activate deferred tools",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-composition-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		const childRuntimes: AgentSessionRuntime[] = [];
		try {
			await Promise.all([mkdir(agentDir), mkdir(cwd)]);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			await copyFile(resolve(extensionDir, "../xsettings.toml"), join(agentDir, "xsettings.toml"));
			await writeFile(join(cwd, "sample.txt"), "first needle\nsecond line\n");
			const fixture = join(agentDir, "deferred.ts");
			await writeFile(
				fixture,
				`export default function (pi) {
			pi.registerTool({ name: "cg_status", label: "Fixture status", description: "Inspect fixture index status",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "fixture ready" }], details: {} }; }
			});
		}`,
			);
			await writeFile(
				join(agentDir, "settings.json"),
				JSON.stringify({
					extensions: ["runtime-support", "fileops", "apply-patch", "exec-command", "code-mode", "tool-search"]
						.map((name) => join(extensionDir, name, "index.ts"))
						.concat(fixture),
				}),
			);
			const settingsManager = SettingsManager.create(cwd, agentDir);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
				modelsStorePath: join(agentDir, "models-cache"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const model = modelRuntime.getModel("openai", "gpt-5.4");
			expect(model).toBeDefined();
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime,
				resourceLoader: loader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
			}));
			const errors: unknown[] = [];
			await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
			const active = session.getActiveToolNames();
			expect(active).toContain("exec");
			expect(active).toContain("tool_search");
			for (const name of [
				"read",
				"search",
				"find",
				"edit",
				"write",
				"apply_patch",
				"exec_command",
				"write_stdin",
				"cg_status",
				"bash",
			])
				expect(active).not.toContain(name);
			expect(new Set(active).size).toBe(active.length);
			await session.extensionRunner.emitBeforeAgentStart("fixture prompt", undefined, "Fixture system prompt", { cwd });
			for (const name of ["exec_command", "write_stdin", "apply_patch", "read"])
				expect(session.getActiveToolNames()).not.toContain(name);
			const invoke = async (name: string, args: Record<string, unknown>) => {
				const tool = session!.getToolDefinition(name)!;
				return tool.execute(
					`test-${name}`,
					args,
					new AbortController().signal,
					undefined,
					session!.extensionRunner.createContext(),
				);
			};
			expect(JSON.stringify(await invoke("exec", { code: 'text("host-ready")' }))).toContain("host-ready");
			const result = await invoke("exec", {
				code: `// @exec: {"yield_time_ms":1000}
			text(await tools.read({path:"sample.txt", raw:true}));
			text(await tools.search({pattern:"needle",path:"sample.txt"}));
			text(await tools.exec_command({cmd:"printf shell-ready",yield_time_ms:1000}));
			text(await tools.apply_patch({input:"*** Begin Patch\\n*** Update File: sample.txt\\n@@\\n-first needle\\n+changed needle\\n*** End Patch"}));
		`,
			});
			const output = JSON.stringify(result);
			expect(output).toContain("first needle");
			expect(output).toContain("shell-ready");
			expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("changed needle\nsecond line\n");
			const failure = await invoke("exec", {
				code: `try { await tools.exec_command({cmd:"exit 7",yield_time_ms:1000}); } catch (error) { text("caught-shell-failure"); }`,
			});
			expect(JSON.stringify(failure)).toContain("caught-shell-failure");
			const runner = await import(
				new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href
			);
			const hierarchy = await import(
				new URL("./protocol/hierarchy.ts", import.meta.resolve("@luan.sh/pi-code-mode")).href
			);
			const foreignScope = Symbol("unrelated-session");
			try {
				hierarchy.setLiftedToolNames(foreignScope, ["private_sibling_tool"], {});
				const prepared = await runner.prepareAgentRun(
					session.extensionRunner.createContext(),
					{
						pi: { getActiveTools: () => session!.getActiveToolNames(), getThinkingLevel: () => session!.thinkingLevel },
						agentConfig: {},
					},
					false,
				);
				expect(prepared.toolNames).not.toContain("private_sibling_tool");
			} finally {
				hierarchy.setLiftedToolNames(foreignScope, []);
			}
			const childRuns = await Promise.all(
				["left", "right"].map(async (name) => {
					const childCwd = join(root, name);
					await mkdir(childCwd);
					await writeFile(join(childCwd, "sample.txt"), `child-${name}`);
					return runner.runAgent(session!.extensionRunner.createContext(), "No model request", {
						pi: { getActiveTools: () => session!.getActiveToolNames(), getThinkingLevel: () => session!.thinkingLevel },
						agentConfig: {},
						cwd: childCwd,
						sessionDir: join(agentDir, "sessions"),
						onRuntimeCreated: (runtime: AgentSessionRuntime) => childRuntimes.push(runtime),
						onSessionCreated(child: NonNullable<typeof session>) {
							// Exercise resource discovery/binding and tool execution while replacing only the model turn.
							child.prompt = async () => {
								const childTools = child.getActiveToolNames();
								expect(childTools).toContain("exec");
								for (const tool of ["read", "search", "apply_patch", "exec_command", "write_stdin", "cg_status"])
									expect(childTools).not.toContain(tool);
								const result = await child
									.getToolDefinition("exec")!
									.execute(
										"child-read",
										{ code: 'text(await tools.read({path:"sample.txt",raw:true}));' },
										new AbortController().signal,
										undefined,
										child.extensionRunner.createContext(),
									);
								expect(JSON.stringify(result)).toContain(`child-${name}`);
							};
						},
					});
				}),
			);
			await Promise.all(childRuns.map((child) => child.runtime.dispose()));
			childRuntimes.length = 0;
			expect(
				JSON.stringify(await invoke("exec", { code: 'text(await tools.read({path:"sample.txt",raw:true}));' })),
			).toContain("changed needle");
			const found = await invoke("tool_search", { query: "cg_status", limit: 1 });
			expect(JSON.stringify(found)).toContain("cg_status");
			expect(session.getActiveToolNames()).toContain("cg_status");
			expect(JSON.stringify(await invoke("cg_status", {}))).toContain("fixture ready");
			expect(errors).toEqual([]);
		} finally {
			await Promise.all(childRuntimes.map((runtime) => runtime.dispose()));
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
