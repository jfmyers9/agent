import { afterEach, expect, test } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execute, GitWork } from "./git";
import { FakeLinear, settings, temporaryRoot } from "./fixtures.test-support";
import workExtension, { configure, settingsSummary, validSettings, type WorkDependencies } from "./index";
import { WorkStore } from "./store";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
	const path = await temporaryRoot();
	roots.push(path);
	return path;
}

test("interactive setup stores an explicitly authorized policy outside the repository", async () => {
	const path = await root();
	const repo = join(path, "repo");
	await mkdir(repo);
	await execute(repo, "git", ["init", "--initial-branch=main"]);
	await execute(repo, "git", ["remote", "add", "origin", "git@github.com:example/project.git"]);
	await writeFile(
		join(repo, "package.json"),
		JSON.stringify({ packageManager: "bun@1.3.0", scripts: { check: "test -f app.txt" } }),
	);
	const store = new WorkStore(join(path, "state"));
	const confirmations: string[] = [];
	const linear = new FakeLinear();
	linear.projects = [{ id: "P-TEAM-1", uuid: "project-uuid", name: "Example" }];
	let allow = false;
	const ctx = {
		cwd: repo,
		ui: {
			select: async (_title: string, choices: string[]) => choices[0],
			input: async (title: string) => (title.startsWith("Required ready label") ? "agent-ready" : ""),
			confirm: async (_title: string, body: string) => {
				confirmations.push(body);
				return allow;
			},
		},
	} as unknown as ExtensionCommandContext;
	const run: typeof execute = (cwd, command, args, options) =>
		command === "gh" ? Promise.resolve({ stdout: "{}", stderr: "" }) : execute(cwd, command, args, options);
	expect(await configure(ctx, linear, store, run)).toBeUndefined();
	expect(await store.settings(join(await realpath(repo), ".git"))).toBeUndefined();
	allow = true;
	const configured = (await configure(ctx, linear, store, run))!;
	expect(configured.projectId).toBe("project-uuid");
	expect(configured.publish).toBe("draft-pr");
	expect(configured.verify).toBe("bun run check");
	expect(configured.base).toBe("main");
	expect(configured.minutes).toBe(45);
	expect(await store.settings(configured.commonDir)).toEqual(configured);
	expect(confirmations.at(-1)).toContain("not a sandbox");
	expect(settingsSummary(configured)).toContain("assigned to you");
	expect(validSettings({ ...configured, publish: "surprise" } as any)).toBe(false);
	expect(validSettings({ ...configured, minutes: 0 })).toBe(false);
});

function harness(path: string, dependencies: WorkDependencies) {
	const handlers = new Map<string, any[]>();
	const messages: string[] = [];
	let command: any;
	const ctx = {
		cwd: path,
		hasUI: true,
		model: undefined,
		sessionManager: { getSessionId: () => "coordinator" },
		ui: { notify: (message: string) => messages.push(message), setStatus() {}, confirm: async () => true },
	} as unknown as ExtensionCommandContext;
	workExtension(
		{
			on(name: string, handler: any) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			getThinkingLevel: () => "high",
			registerCommand(name: string, definition: any) {
				expect(name).toBe("work");
				command = definition.handler;
			},
		} as unknown as ExtensionAPI,
		dependencies,
	);
	return {
		ctx,
		messages,
		command: (args: string) => command(args, ctx),
		async event(name: string) {
			for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
		},
	};
}

test("the command reuses settings, prevents duplicate starts, and stops its worker on shutdown", async () => {
	const path = await root();
	const store = new WorkStore(join(path, "state"));
	const config = settings(path);
	await store.saveSettings(config);
	const linear = new FakeLinear();
	let connections = 0;
	let closes = 0;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const git = new GitWork();
	git.preflight = async () => {};
	git.prepare = async () => {};
	const h = harness(path, {
		store,
		git,
		repository: async () => ({ repo: path, commonDir: config.commonDir, remote: config.remote, base: "main" }),
		connect: async () => {
			connections++;
			return {
				call: linear.call.bind(linear),
				close: async () => {
					closes++;
				},
			};
		},
		configure: async () => {
			throw new Error("Should reuse settings");
		},
		worker: () => ({
			async run(_job, signal) {
				entered();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
				});
				throw new Error("Unexpected continuation");
			},
		}),
	});
	await h.event("session_start");
	await h.command("loop");
	await started;
	await h.command("loop");
	expect(connections).toBe(1);
	expect(h.messages.at(-1)).toContain("already has a work operation");
	await h.command("status");
	expect(h.messages.at(-1)).toContain("DEV-1");
	await h.event("session_shutdown");
	expect(closes).toBe(1);
	expect(await store.owner()).toBeUndefined();
	expect((await store.job("DEV-1"))?.phase).toBe("interrupted");
}, 5000);

test("canceling first-run setup closes the service and never claims work", async () => {
	const path = await root();
	const store = new WorkStore(join(path, "state"));
	const linear = new FakeLinear();
	let closes = 0;
	const h = harness(path, {
		store,
		repository: async () => ({ ...settings(path) }),
		connect: async () => ({
			call: linear.call.bind(linear),
			close: async () => {
				closes++;
			},
		}),
		configure: async () => undefined,
	});
	await h.command("");
	expect(closes).toBe(1);
	expect(await store.owner()).toBeUndefined();
	expect(linear.calls.some((call) => call.name === "save_issue")).toBe(false);
});
