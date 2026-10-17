import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_USAGE_ENTRY_TYPE } from "./accounting";
import { branchRoutingState, registerRouting } from "./index";
import { ROUTING_MODEL, ROUTING_PROVIDER, type RoutingSettings } from "./settings";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

/** Real native resource/extension/model/session plumbing; only the provider responses and preference store are fake. */
async function fixture(configured = true) {
	const root = await mkdtemp(join(tmpdir(), "pi-routing-native-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-cache"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		provider: "routing-fixture",
		models: ["luna", "sol", "astra"].map((id) => ({
			id,
			reasoning: false,
			contextWindow: 32_000,
			maxTokens: 4_096,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		})),
		tokenSize: { min: 1_024, max: 1_024 },
	});
	const provider = {
		...faux.provider,
		auth: {
			apiKey: {
				name: "Fixture key",
				check: async () => ({ type: "api_key" as const, source: "fixture" }),
				resolve: async () => ({ auth: { apiKey: "fixture" } }),
			},
		},
	};
	runtime.registerNativeProvider(provider);
	await runtime.getAvailable();
	const ref = (id: string) => ({ provider: faux.provider.id, id });
	const prefs: RoutingSettings = {
		version: 1,
		classifier: ref("luna"),
		tiers: { luna: ref("luna"), sol: ref("sol"), astra: ref("astra") },
		subagents: true,
		timeoutMs: 1_000,
		maxTokens: 1_024,
	};
	const sessions: Session[] = [];
	const errors: unknown[] = [];
	const dispatches: string[] = [];
	let saves = 0;
	function step(
		content: Parameters<typeof fauxAssistantMessage>[0],
		stopReason: "stop" | "toolUse" = "stop",
	): FauxResponseStep {
		return (_context, _options, _state, model) => {
			dispatches.push(model.id);
			return fauxAssistantMessage(content, { stopReason });
		};
	}
	async function open(manager = SessionManager.create(cwd, join(root, "sessions")), initial = true) {
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			systemPrompt: "Complete the fixture task.",
			extensionFactories: [
				{
					name: "routing-fixture",
					factory: (pi) => {
						pi.registerProvider(provider);
						registerRouting(pi, {
							load: async () => (configured ? prefs : undefined),
							save: async () => {
								saves++;
							},
						});
					},
				},
			],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: manager,
			...(initial ? { model: faux.getModel("sol") } : {}),
			thinkingLevel: "off",
			tools: ["fixture_echo"],
			customTools: [
				{
					name: "fixture_echo",
					label: "Fixture echo",
					description: "Return fixture output",
					parameters: { type: "object", properties: {} } as never,
					execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
				},
			],
		});
		sessions.push(session);
		await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
		await runtime.refresh({ allowNetwork: false, providers: [faux.provider.id] });
		// Registration queues availability refreshes; wait for the synchronous registry snapshot used by routes.
		await runtime.getAvailable();
		expect(runtime.hasConfiguredAuth(faux.provider.id)).toBe(true);
		return session;
	}
	return {
		runtime,
		faux,
		cwd,
		root,
		open,
		dispatches,
		errors,
		step,
		get saves() {
			return saves;
		},
		classifier: () =>
			step(JSON.stringify({ tier: "luna", reason: "Specified local edit.", insufficient_context: false })),
		auto: () => runtime.getModel(ROUTING_PROVIDER, ROUTING_MODEL)!,
		close: async () => {
			for (const session of sessions) session.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("native SDK loads Auto opt-in, classifies user once, and routes tool continuation on its physical model", async () => {
	const h = await fixture();
	try {
		const session = await h.open();
		expect(session.model?.id).toBe("sol");
		expect(h.auto().api).toBe("pi-virtual");
		expect(session.extensionRunner.getCommand("routing")).toBeDefined();
		expect(h.saves).toBe(0);
		expect(h.faux.state.callCount).toBe(0);
		await session.setModel(h.auto());
		h.faux.setResponses([
			h.classifier(),
			h.step(fauxToolCall("fixture_echo", {}, { id: "echo" }), "toolUse"),
			h.step("Done."),
		]);
		await session.prompt("Correct the specified typo in the supplied paragraph.");
		expect(session.model?.provider).toBe(ROUTING_PROVIDER);
		expect(session.model?.id).toBe(ROUTING_MODEL);
		expect(session.getLastAssistantText()).toBe("Done.");
		expect(h.dispatches).toEqual(["luna", "luna", "luna"]);
		expect(h.faux.state.callCount).toBe(3);
		const state = branchRoutingState(session.extensionRunner.createContext());
		expect(state).toMatchObject({ tier: "luna", model: { provider: "routing-fixture", id: "luna" } });
		const usage = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE);
		expect(usage).toHaveLength(1);
		expect((usage[0] as any).data.usage.totalTokens).toBeGreaterThan(0);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);

test("native persisted branch state survives compaction, resume, tree navigation, and full-history fork", async () => {
	const h = await fixture();
	try {
		let session = await h.open();
		await session.setModel(h.auto());
		h.faux.setResponses([h.classifier(), h.step("Original task complete.")]);
		await session.prompt("Correct the specified typo.");
		const manager = session.sessionManager;
		const state = branchRoutingState(session.extensionRunner.createContext());
		expect(state).toBeDefined();
		const originalLeaf = manager.getLeafId()!;
		manager.appendCompaction("Summary of the original task.", originalLeaf, 500);
		expect(branchRoutingState(session.extensionRunner.createContext())).toEqual(state);
		const file = manager.getSessionFile()!;
		session.dispose();
		session = await h.open(SessionManager.open(file), false);
		expect(session.model?.id).toBe(ROUTING_MODEL);
		expect(branchRoutingState(session.extensionRunner.createContext())).toEqual(state);
		const navigation = await session.navigateTree(originalLeaf, { summarize: false });
		expect(navigation.cancelled).toBe(false);
		expect(branchRoutingState(session.extensionRunner.createContext())).toEqual(state);
		// Acknowledgement follows the restored task model without paying for another classification.
		h.faux.setResponses([h.step("Continuing the original task.")]);
		await session.prompt("continue");
		expect(h.faux.state.callCount).toBe(3);
		expect(branchRoutingState(session.extensionRunner.createContext())).toEqual(state);
		const fork = SessionManager.forkFrom(file, h.cwd, join(h.root, "forks"));
		session.dispose();
		const child = await h.open(fork, false);
		expect(child.model?.id).toBe(ROUTING_MODEL);
		expect(branchRoutingState(child.extensionRunner.createContext())).toEqual(state);
		expect(
			child.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE),
		).toHaveLength(1);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);

test("native route context reports unconfigured routing and unavailable authentication without provider dispatch", async () => {
	for (const configured of [false, true]) {
		const h = await fixture(configured);
		try {
			await h.open();
			if (configured) {
				h.runtime.registerNativeProvider({
					...h.faux.provider,
					auth: { apiKey: { name: "Unavailable fixture", resolve: async () => undefined } },
				});
				await h.runtime.refresh({ allowNetwork: false, providers: [h.faux.provider.id] });
				await h.runtime.getAvailable();
			}
			await expect(
				h.runtime.resolveModel(h.auto(), [{ role: "user", content: "Specified task", timestamp: 1 }], {
					reason: "user",
					thinkingLevel: "off",
				}),
			).rejects.toThrow(configured ? "authentication" : "not configured");
			expect(h.faux.state.callCount).toBe(0);
			expect(h.saves).toBe(0);
		} finally {
			await h.close();
		}
	}
}, 15_000);
