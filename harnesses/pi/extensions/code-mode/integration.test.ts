import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSessionRuntime,
	createAgentSession,
	createCodemodeExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("installed extensions compose local tools and activate deferred tools", async () => {
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
			pi.registerTool({ name: "cg_status", label: "Fixture status", exposure: "deferred", description: "Inspect fixture index status",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "fixture ready" }], details: {} }; }
			});
		}`,
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultTools: ["+codemode", "+tool_search", "+request_user_input_async"],
				codemode: { mode: "only" },
				extensions: [
					"runtime-support",
					"collapse-transcript",
					"fileops",
					"apply-patch",
					"exec-command",
					"async-questions",
				]
					.map((name) => join(extensionDir, name, "index.ts"))
					.concat(fixture),
			}),
		);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			extensionFactories: [createCodemodeExtension(), createToolSearchExtension()],
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
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).defaultTools).toEqual([
			"+codemode",
			"+tool_search",
			"+request_user_input_async",
		]);
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
		expect(active).toContain("codemode");
		expect(active).toContain("tool_search");
		for (const name of ["read", "search", "apply_patch", "exec_command", "write_stdin"]) expect(active).toContain(name);
		expect(active).not.toContain("cg_status");
		expect(active).not.toContain("bash");
		expect(active).toContain("request_user_input_async");
		expect(session.getCallableToolNames()).not.toContain("request_user_input_async");
		expect(new Set(active).size).toBe(active.length);
		await session.extensionRunner.emitBeforeAgentStart("fixture prompt", undefined, "Fixture system prompt", { cwd });
		for (const name of ["exec_command", "write_stdin", "apply_patch", "read"])
			expect(session.getActiveToolNames()).toContain(name);
		const invoke = async (name: string, args: Record<string, unknown>) => {
			session!.agent.state.messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id: `test-${name}`, name, arguments: args }],
				api: "openai-responses",
				provider: "openai",
				model: "fixture",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			});
			const tool = session!.getToolDefinition(name)!;
			return tool.execute(
				`test-${name}`,
				args,
				new AbortController().signal,
				undefined,
				session!.extensionRunner.createToolContext(`test-${name}`, new AbortController().signal),
			);
		};
		expect(JSON.stringify(await invoke("codemode", { code: 'text("host-ready")' }))).toContain("host-ready");
		const result = await invoke("codemode", {
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
		const large = await invoke("codemode", {
			code: `const result = await tools.exec_command({cmd: "python3 -c 'print(str(1234567890)*9000)'", yield_time_ms:1000}); text(typeof result.details); text(Array.isArray(result.content));`,
		});
		expect(JSON.stringify(large)).toContain("object");
		expect(JSON.stringify(large)).toContain("true");
		const failure = await invoke("codemode", {
			code: `try { await tools.exec_command({cmd:"exit 7",yield_time_ms:1000}); } catch (error) { text("caught-shell-failure"); }`,
		});
		expect(JSON.stringify(failure)).toContain("caught-shell-failure");
		const runner = await import(
			new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href
		);

		const childRuns = await Promise.all(
			["left", "right"].map(async (name) => {
				const childCwd = join(root, name);
				await mkdir(childCwd);
				await writeFile(join(childCwd, "sample.txt"), `child-${name}`);
				return runner.runAgent(
					session!.extensionRunner.createToolContext(`test-${name}`, new AbortController().signal),
					"No model request",
					{
						pi: {
							getActiveTools: () => session!.getActiveToolNames(),
							getAllTools: () => session!.getAllTools(),
							getThinkingLevel: () => session!.thinkingLevel,
						},
						agentConfig: {},
						cwd: childCwd,
						sessionDir: join(agentDir, "sessions"),
						onRuntimeCreated: (runtime: AgentSessionRuntime) => childRuntimes.push(runtime),
						onSessionCreated(child: NonNullable<typeof session>) {
							// Exercise resource discovery/binding and tool execution while replacing only the model turn.
							child.prompt = async () => {
								const childTools = child.getActiveToolNames();
								expect(childTools).toContain("codemode");
								expect(childTools).not.toContain("cg_status");
								expect(child.getCallableToolNames()).toContain("cg_status");
								for (const tool of ["read", "search", "apply_patch", "exec_command", "write_stdin"])
									expect(childTools).toContain(tool);
								child.agent.state.messages.push({
									role: "assistant",
									content: [{ type: "toolCall", id: "child-read", name: "codemode", arguments: { code: "" } }],
									api: "openai-responses",
									provider: "openai",
									model: "fixture",
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									stopReason: "toolUse",
									timestamp: Date.now(),
								});
								const result = await child
									.getToolDefinition("codemode")!
									.execute(
										"child-read",
										{ code: 'text(await tools.read({path:"sample.txt",raw:true}));' },
										new AbortController().signal,
										undefined,
										child.extensionRunner.createToolContext("child-read", new AbortController().signal),
									);
								expect(JSON.stringify(result)).toContain(`child-${name}`);
							};
						},
					},
				);
			}),
		);
		await Promise.all(childRuns.map((child) => child.runtime.dispose()));
		childRuntimes.length = 0;
		expect(
			JSON.stringify(await invoke("codemode", { code: 'text(await tools.read({path:"sample.txt",raw:true}));' })),
		).toContain("changed needle");
		const found = await invoke("tool_search", { query: "cg_status", limit: 1 });
		expect(JSON.stringify(found)).toContain("cg_status");
		expect(session.getActiveToolNames()).toContain("cg_status");
		expect(JSON.stringify(await invoke("cg_status", {}))).toContain("fixture ready");
		const beforeQuestion = session.sessionManager.appendCustomEntry("async-test/branch", {});
		const question = await invoke("request_user_input_async", {
			questions: [{ title: "Which output format?", options: ["JSON", "Text"] }],
		});
		expect(JSON.stringify(question)).toContain('"accepted":true');
		expect(
			session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "pi-conversation/question"),
		).toBe(true);
		await session.navigateTree(beforeQuestion, { summarize: false });
		expect(session.getActiveToolNames()).toContain("request_user_input_async");
		expect(session.getCallableToolNames()).not.toContain("request_user_input_async");
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).not.toContain("edit");
		expect(
			session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "pi-conversation/question"),
		).toBe(false);
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
}, 30_000);
