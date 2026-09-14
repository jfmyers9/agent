import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test.skipIf(!process.env.PI_CODE_MODE_HOST_BINARY)(
	"concurrently loaded child sessions keep their own nested tool closures",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-child-ownership-"));
		const agentDir = join(root, "agent");
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
		try {
			await mkdir(agentDir);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			await writeFile(
				join(agentDir, "xsettings.toml"),
				'[tools]\npi-code-mode.enabled = true\npi-code-mode.tools = ["read"]\n',
			);
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
				modelsStorePath: join(agentDir, "models-cache"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const loaded = await Promise.all(
				["first", "second"].map(async (name) => {
					const cwd = join(root, name);
					await mkdir(cwd);
					const fixture = join(root, `${name}.ts`);
					await writeFile(
						fixture,
						`import { registerCodeModeTool } from ${JSON.stringify(join(extensionDir, "shared/code-mode.ts"))};
export default function (pi) {
  registerCodeModeTool(pi, { name: "read", label: "Read", description: "Read ${name}", parameters: { type: "object", properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      return { content: [{ type: "text", text: "owner-${name}:" + ctx.cwd }], details: {} };
    }
  });
}`,
					);
					const settingsManager = SettingsManager.create(cwd, agentDir);
					const resourceLoader = new DefaultResourceLoader({
						cwd,
						agentDir,
						settingsManager,
						additionalExtensionPaths: [
							join(extensionDir, "runtime-support/index.ts"),
							fixture,
							join(extensionDir, "code-mode/index.ts"),
						],
						noSkills: true,
						noThemes: true,
						noPromptTemplates: true,
						noContextFiles: true,
					});
					await resourceLoader.reload();
					expect(resourceLoader.getExtensions().errors).toEqual([]);
					return { cwd, settingsManager, resourceLoader, name };
				}),
			);
			// Both sets of adapter owners now exist, before either runtime claims them.
			for (const { cwd, settingsManager, resourceLoader } of loaded) {
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					modelRuntime,
					resourceLoader,
					settingsManager,
					sessionManager: SessionManager.inMemory(cwd),
				});
				sessions.push(session);
			}
			const errors: unknown[] = [];
			await Promise.all(
				sessions.map((session) => session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) })),
			);
			const results = await Promise.all(
				sessions.map(async (session, index) => {
					expect(session.getActiveToolNames()).not.toContain("read");
					const tool = session.getToolDefinition("exec")!;
					const result = await tool.execute(
						"owner-test",
						{ code: "text(await tools.read({}));" },
						new AbortController().signal,
						undefined,
						session.extensionRunner.createContext(),
					);
					return { output: JSON.stringify(result), fixture: loaded[index]! };
				}),
			);
			for (const { output, fixture } of results) {
				expect(output).toContain(`owner-${fixture.name}:${fixture.cwd}`);
				expect(output).not.toContain(`owner-${fixture.name === "first" ? "second" : "first"}:`);
			}
			expect(errors).toEqual([]);
		} finally {
			for (const session of sessions) {
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
