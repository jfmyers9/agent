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
import { sumSessionCosts } from "../tui/cost";
import { CLASSIFIER_USAGE_ENTRY_TYPE } from "./accounting";
import { pendingAssessment } from "./affinity";
import { branchRoutingState, registerRouting } from "./index";
import { manualPin } from "./pin";
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
		models: ["luna", "sol", "astra", "manual"].map((id) => ({
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
	async function open(
		manager = SessionManager.create(cwd, join(root, "sessions")),
		initial = true,
		options: { runtime?: ModelRuntime; registerProvider?: boolean } = {},
	) {
		const sessionRuntime = options.runtime ?? runtime;
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
						if (options.registerProvider !== false) pi.registerProvider(provider);
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
			modelRuntime: sessionRuntime,
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
		await sessionRuntime.refresh({ allowNetwork: false, providers: [faux.provider.id] });
		// Registration queues availability refreshes; wait for the synchronous registry snapshot used by routes.
		await sessionRuntime.getAvailable();
		expect(sessionRuntime.hasConfiguredAuth(faux.provider.id)).toBe(true);
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
		classifier:
			(tier: "luna" | "sol" | "astra" = "luna"): FauxResponseStep =>
			(context, options, state, model) => {
				const message = context.messages.at(-1)!;
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("");
				const envelope = JSON.parse(text).envelope;
				return step(
					JSON.stringify({
						tier,
						reason: "Fixture capability assessment.",
						insufficient_context: false,
						active_work: {
							objective: envelope.activeWork?.objective ?? envelope.task.slice(0, 400),
							constraints: envelope.activeWork?.constraints ?? [],
							remaining: ["Complete fixture work"],
						},
					}),
				)(context, options, state, model);
			},
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
		// Acknowledgement is reassessed, but cannot downgrade the held model.
		h.faux.setResponses([h.classifier("luna"), h.step("Continuing the original task.")]);
		await session.prompt("continue");
		expect(h.faux.state.callCount).toBe(4);
		expect(branchRoutingState(session.extensionRunner.createContext())).toMatchObject({
			tier: state?.tier,
			model: state?.model,
		});
		const fork = SessionManager.forkFrom(file, h.cwd, join(h.root, "forks"));
		session.dispose();
		const child = await h.open(fork, false);
		expect(child.model?.id).toBe(ROUTING_MODEL);
		expect(branchRoutingState(child.extensionRunner.createContext())).toMatchObject({
			tier: state?.tier,
			model: state?.model,
		});
		expect(branchRoutingState(child.extensionRunner.createContext())?.activeWork?.objective).toBe(
			state?.activeWork?.objective,
		);
		expect(
			child.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE),
		).toHaveLength(2);
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

test("native session reassesses every distinct user follow-up and upgrades only when complexity rises", async () => {
	const h = await fixture();
	try {
		const session = await h.open();
		await session.setModel(h.auto());
		h.faux.setResponses([h.classifier(), h.step("Initial work done.")]);
		await session.prompt("Implement the supplied local change.");
		const state = branchRoutingState(session.extensionRunner.createContext());
		const initialEntries = session.sessionManager.getEntries();
		const receiptCount = (entries: typeof initialEntries) =>
			entries.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE).length;
		const routeCount = (entries: typeof initialEntries) =>
			entries.filter((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state").length;
		for (let i = 0; i < 20; i++) {
			h.faux.setResponses([h.classifier("luna"), h.step("Follow-up complete.")]);
			await session.prompt(`Also add regression coverage for scenario ${i}`);
			expect(branchRoutingState(session.extensionRunner.createContext())).toMatchObject({
				tier: state?.tier,
				model: state?.model,
			});
		}
		expect(h.faux.state.callCount).toBe(42);
		expect(receiptCount(session.sessionManager.getEntries())).toBe(21);
		expect(routeCount(session.sessionManager.getEntries()) - routeCount(initialEntries)).toBe(20);
		expect(h.dispatches.every((model) => model === "luna")).toBe(true);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);

test("native queued reassessment survives compaction/resume and consumption follows tree and fork state", async () => {
	const h = await fixture();
	try {
		let session = await h.open();
		await session.setModel(h.auto());
		h.faux.setResponses([h.classifier(), h.step("Initial work done.")]);
		await session.prompt("Implement the supplied local change.");
		const originalLeaf = session.sessionManager.getLeafId()!;
		await session.prompt("/routing reassess");
		expect(h.faux.state.callCount).toBe(2);
		const requestedLeaf = session.sessionManager.getLeafId()!;
		const ctx = () => session.extensionRunner.createContext();
		const queued = pendingAssessment(ctx(), branchRoutingState(ctx()))!;
		expect(queued.mode).toBe("reassess");
		session.sessionManager.appendCompaction("Existing task summary", requestedLeaf, 500);
		const file = session.sessionManager.getSessionFile()!;
		session.dispose();
		session = await h.open(SessionManager.open(file), false);
		expect(pendingAssessment(ctx(), branchRoutingState(ctx()))).toEqual(queued);
		h.faux.setResponses([h.classifier("astra"), h.step("Hard task complete.")]);
		await session.prompt("Assess the cross-component recovery redesign.");
		const upgraded = branchRoutingState(ctx())!;
		expect(upgraded).toMatchObject({ tier: "astra", assessmentId: queued.id });
		expect(pendingAssessment(ctx(), upgraded)).toBeUndefined();
		expect(h.dispatches.slice(-2)).toEqual(["luna", "astra"]);

		// Forks inherit the consumed request and do not pay to reassess the same assignment.
		const fork = SessionManager.forkFrom(file, h.cwd, join(h.root, "affinity-forks"));
		session.dispose();
		session = await h.open(fork, false);
		h.faux.setResponses([h.classifier("sol"), h.step("Additional test done.")]);
		await session.prompt("Also add a test for cancellation.");
		expect(h.dispatches.at(-1)).toBe("astra");
		expect(h.faux.state.callCount).toBe(6);
		expect(pendingAssessment(ctx(), branchRoutingState(ctx()))).toBeUndefined();

		// Explicit reset allows a cheaper model; ordinary follow-ups do not.
		await session.prompt("/routing reset");
		expect(h.faux.state.callCount).toBe(6);
		h.faux.setResponses([h.classifier(), h.step("Mechanical work done.")]);
		await session.prompt("New work: apply the supplied mechanical replacement.");
		expect(branchRoutingState(ctx())?.tier).toBe("luna");
		expect(h.faux.state.callCount).toBe(8);

		// Requests on another branch do not leak backwards through navigation.
		await session.navigateTree(originalLeaf, { summarize: false });
		expect(pendingAssessment(ctx(), branchRoutingState(ctx()))).toBeUndefined();
		h.faux.setResponses([h.classifier("sol"), h.step("Original branch work done.")]);
		await session.prompt("Add documentation for the original change.");
		expect(h.faux.state.callCount).toBe(10);
		await session.navigateTree(requestedLeaf, { summarize: false });
		expect(pendingAssessment(ctx(), branchRoutingState(ctx()))).toEqual(queued);
		h.faux.setResponses([h.classifier("sol"), h.step("Branch assessment complete.")]);
		await session.prompt("Investigate the revised implementation.");
		expect(branchRoutingState(ctx())).toMatchObject({ tier: "sol", assessmentId: queued.id });
		expect(h.faux.state.callCount).toBe(12);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);
test("native physical model selection pins it for the session while Auto stays selected across resume", async () => {
	const h = await fixture();
	try {
		let session = await h.open();
		await session.setModel(h.auto());
		const astra = h.runtime.getModel("routing-fixture", "astra")!;
		await session.setModel(astra);
		expect(session.model?.provider).toBe(ROUTING_PROVIDER);
		expect(session.model?.id).toBe(ROUTING_MODEL);
		expect(manualPin(session.extensionRunner.createContext())).toEqual({ provider: "routing-fixture", id: "astra" });
		h.faux.setResponses([h.step("Pinned model response.")]);
		await session.prompt("Continue under my selected physical model.");
		expect(h.dispatches).toEqual(["astra"]);
		expect(h.faux.state.callCount).toBe(1);
		expect(session.getLastAssistantText()).toBe("Pinned model response.");
		const file = session.sessionManager.getSessionFile()!;
		session.dispose();
		session = await h.open(SessionManager.open(file), false);
		expect(session.model?.id).toBe(ROUTING_MODEL);
		expect(manualPin(session.extensionRunner.createContext())).toEqual({ provider: "routing-fixture", id: "astra" });
		h.faux.setResponses([h.step("Still pinned after resume.")]);
		await session.prompt("Another follow-up.");
		expect(h.dispatches).toEqual(["astra", "astra"]);
		expect(h.faux.state.callCount).toBe(2);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);

test("child runtimes inherit physical catalog/auth without replacing parent routes or receipts", async () => {
	const h = await fixture();
	try {
		const parent = await h.open();
		await parent.setModel(h.auto());
		await parent.setModel(h.runtime.getModel("routing-fixture", "astra")!);
		const runner = await import(
			new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href
		);
		const childRuntime = await runner.createChildModelRuntime(parent.extensionRunner.createContext().modelRegistry);
		expect(childRuntime).not.toBe(h.runtime);
		expect(childRuntime.getModel(ROUTING_PROVIDER, ROUTING_MODEL)).toBeUndefined();
		expect(childRuntime.hasConfiguredAuth("routing-fixture")).toBe(true);
		const child = await h.open(undefined, true, { runtime: childRuntime, registerProvider: false });
		h.faux.setResponses([h.step("Parent stays pinned.")]);
		await parent.prompt("Continue the parent assignment.");
		expect(h.dispatches).toEqual(["astra"]);
		await child.setModel(childRuntime.getModel(ROUTING_PROVIDER, ROUTING_MODEL)!);
		h.faux.setResponses([h.classifier("sol"), h.step("Independent child work.")]);
		await child.prompt("Work on the isolated child assignment.");
		const receipts = (session: Session) =>
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE);
		expect(receipts(parent)).toHaveLength(0);
		expect(receipts(child)).toHaveLength(1);
		child.dispose();
		h.faux.setResponses([h.step("Parent works after child disposal.")]);
		await parent.prompt("Continue after the child is closed.");
		expect(h.dispatches.at(-1)).toBe("astra");
		await parent.prompt("/routing reset");
		h.faux.setResponses([h.classifier("sol"), h.step("Parent reassessed.")]);
		await parent.prompt("New parent work.");
		expect(receipts(parent)).toHaveLength(1);
		expect(receipts(child)).toHaveLength(1);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);

test("native reassessment retains the manually selected baseline, including before an initial route", async () => {
	for (const initialRoute of [false, true]) {
		const h = await fixture();
		try {
			const session = await h.open();
			await session.setModel(h.auto());
			if (initialRoute) {
				h.faux.setResponses([h.classifier("luna"), h.step("Initial Luna work.")]);
				await session.prompt("Correct the supplied typo.");
			}
			await session.setModel(h.runtime.getModel("routing-fixture", "astra")!);
			h.faux.setResponses([h.step("Manual Astra work.")]);
			await session.prompt("Continue on my selected model.");
			await session.prompt("/routing reassess");
			expect(manualPin(session.extensionRunner.createContext())).toBeUndefined();
			h.faux.setResponses([h.classifier("luna"), h.step("Retain current Astra baseline.")]);
			await session.prompt("Add the focused test.");
			expect(h.dispatches.at(-1)).toBe("astra");
			expect(branchRoutingState(session.extensionRunner.createContext())).toMatchObject({
				tier: "astra",
				model: { provider: "routing-fixture", id: "astra" },
			});
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
		}
	}
}, 15_000);

test("manual targets outside tier mappings are retained until an explicit reset", async () => {
	const h = await fixture();
	try {
		const session = await h.open();
		await session.setModel(h.auto());
		await session.setModel(h.runtime.getModel("routing-fixture", "manual")!);
		await session.prompt("/routing reassess");
		h.faux.setResponses([h.classifier("astra"), h.step("Retain unordered manual target.")]);
		await session.prompt("Assess the next assignment.");
		expect(h.dispatches.at(-1)).toBe("manual");
		expect(branchRoutingState(session.extensionRunner.createContext())?.tier).toBe("manual");
		await session.prompt("/routing reset");
		h.faux.setResponses([h.classifier("luna"), h.step("New low-risk work.")]);
		await session.prompt("New work: apply the supplied typo correction.");
		expect(h.dispatches.at(-1)).toBe("luna");
		expect(branchRoutingState(session.extensionRunner.createContext())?.task).toBe(
			"New work: apply the supplied typo correction.",
		);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);

test("a manual model selection during native classification controls the pending dispatch", async () => {
	const h = await fixture();
	try {
		const session = await h.open();
		await session.setModel(h.auto());
		h.faux.setResponses([
			async () => {
				await session.setModel(h.runtime.getModel("routing-fixture", "astra")!);
				return fauxAssistantMessage(
					JSON.stringify({
						tier: "luna",
						reason: "Simple work.",
						insufficient_context: false,
						active_work: { objective: "Begin the work", constraints: [], remaining: ["Implement"] },
					}),
				);
			},
			h.step("The manual choice wins this request."),
		]);
		await session.prompt("Classify, then begin the work.");
		expect(h.dispatches).toEqual(["astra"]);
		expect(branchRoutingState(session.extensionRunner.createContext())?.model.id).toBe("astra");
		expect(manualPin(session.extensionRunner.createContext())?.id).toBe("astra");
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "routing:decision-v1"),
		).toHaveLength(0);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE),
		).toHaveLength(1);
		expect(h.errors).toEqual([]);
	} finally {
		await h.close();
	}
}, 15_000);

test("reload persists unknown spend before abandoning a timed-out classifier transport", async () => {
	const h = await fixture();
	const originalComplete = h.runtime.complete;
	try {
		const session = await h.open();
		await session.setModel(h.auto());
		let finish!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
		let transportSignal: AbortSignal | undefined;
		h.runtime.complete = async (_model, _context, options) => {
			transportSignal = options?.signal;
			return new Promise((resolve) => {
				finish = resolve;
			});
		};
		h.faux.setResponses([h.step("Conservative timeout fallback.")]);
		await session.prompt("Classify this work with a transport that ignores cancellation.");
		expect(transportSignal?.aborted).toBe(true);
		const before = await session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });
		expect(before?.cancel).toBe(true);
		await session.reload();
		const receipts = () =>
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE);
		expect(receipts()).toHaveLength(1);
		expect(receipts()[0]).toMatchObject({ data: { provider: "routing-fixture", model: "luna" } });
		expect(receipts()[0].data).not.toHaveProperty("usage");
		expect(
			sumSessionCosts(session.sessionManager.getEntries(), session.extensionRunner.createContext().modelRegistry)
				.missing,
		).toBe(1);
		finish(fauxAssistantMessage(JSON.stringify({ tier: "luna", reason: "Late result.", insufficient_context: false })));
		await Promise.resolve();
		await Promise.resolve();
		expect(receipts()).toHaveLength(1); // No stale callback or duplicate missing-usage receipt.
		expect(h.errors).toEqual([]);
	} finally {
		h.runtime.complete = originalComplete;
		await h.close();
	}
}, 15_000);

test("native incomplete and malformed assessments both upgrade Luna to Sol without losing good scope", async () => {
	for (const malformed of [false, true]) {
		const h = await fixture();
		try {
			const session = await h.open();
			await session.setModel(h.auto());
			h.faux.setResponses([h.classifier("luna"), h.step("Initial bounded work complete.")]);
			await session.prompt("Correct the supplied typo.");
			const original = branchRoutingState(session.extensionRunner.createContext())?.activeWork;
			const brief = {
				objective: "Implement configuration-editor UI structure",
				constraints: ["Use the proposed configuration-editor design"],
				remaining: ["Discover component structure", "Implement and verify the UI"],
			};
			h.faux.setResponses([
				() =>
					fauxAssistantMessage(
						malformed
							? "malformed response"
							: JSON.stringify({
									tier: "sol",
									reason: "Moderate product and codebase discovery.",
									insufficient_context: true,
									active_work: brief,
								}),
					),
				h.step("Continue on the conservative Sol model."),
			]);
			await session.prompt("Implement the configuration-editor redesign.");
			expect(h.dispatches.at(-1)).toBe("sol");
			const state = branchRoutingState(session.extensionRunner.createContext());
			expect(state?.tier).toBe("sol");
			expect(state?.activeWork).toEqual(malformed ? original : brief);
			expect(state?.reason).toContain(malformed ? "Assessment failed" : "Recommended sol");
			expect(state?.reason).not.toContain("Unreliable");
			expect(h.errors).toEqual([]);
		} finally {
			await h.close();
		}
	}
}, 15_000);

test("native Auto child dispatch is visible in subagent snapshots and tool results before settlement", async () => {
	const base = import.meta.resolve("@luan.sh/pi-subagents");
	const { createRootCoordinator, removeRootCoordinator } = await import(new URL("./runtime/coordinator.ts", base).href);
	const { listAgentsResult } = await import(new URL("./tools/list-agents/result.ts", base).href);
	const h = await fixture();
	const rootId = `model-display-${h.root}`;
	try {
		const session = await h.open();
		await session.setModel(h.auto());
		h.faux.setResponses([h.classifier("sol"), h.step("Child work complete.")]);
		const coordinator = createRootCoordinator(rootId, {
			maxConcurrency: 2,
			run: async (_ctx: unknown, prompt: string, options: any) => {
				options.onRuntimeResolved({ model: { provider: ROUTING_PROVIDER, id: ROUTING_MODEL }, thinkingLevel: "off" });
				options.onSessionCreated(session);
				await session.prompt(prompt);
				return { session, responseText: session.getLastAssistantText(), runtime: { dispose: async () => {} } };
			},
		});
		const seen: any[] = [];
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		coordinator.subscribe((event: any) => {
			if (event.type === "updated") seen.push(event.agent);
			if (event.type === "settled") resolveSettled();
		});
		coordinator.spawn(undefined, {
			taskName: "worker",
			message: "Implement the scoped configuration option.",
			pi: {},
			ctx: { cwd: h.cwd, sessionManager: SessionManager.inMemory() },
			agentConfig: { model: { provider: ROUTING_PROVIDER, id: ROUTING_MODEL } },
			forkTurns: "none",
		});
		await settled;
		expect(seen.some((agent) => agent.status === "running" && agent.model?.id === "sol")).toBe(true);
		expect(seen.some((agent) => agent.model?.id === "luna")).toBe(false); // Classifier is not the execution model.
		const listed = listAgentsResult(coordinator.snapshot(), undefined);
		expect(listed.details.agents[0]).toMatchObject({
			model: "routing-fixture/sol",
			selectedModel: "routing/auto",
			thinkingLevel: "off",
			status: "idle",
		});
		expect(session.model?.api).toBe("pi-virtual");
		expect(coordinator.checkpoint().agents[0].model).toEqual({ provider: ROUTING_PROVIDER, id: ROUTING_MODEL });
		expect(h.errors).toEqual([]);
	} finally {
		removeRootCoordinator(rootId);
		await h.close();
	}
}, 15_000);
