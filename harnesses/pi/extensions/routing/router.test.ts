import { expect, test } from "bun:test";
import type { Api, AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { ASSESSMENT_ENTRY, type AssessmentRequest } from "./affinity.js";
import type { ClassifierOptions, classifyTask } from "./classifier.js";
import { isAuto, isRoutingState, physicalModel, type RoutingState, TaskRouter, taskEnvelope } from "./router.js";
import type { RoutingSettings } from "./settings.js";
import type { ClassifierResult, ClassifierUsage, TaskEnvelope } from "./types.js";

function model(id: string, provider = "fixture"): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		input: ["text"],
		reasoning: true,
		contextWindow: 32_000,
		maxTokens: 4_096,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
}
const models = { classifier: model("classifier"), luna: model("luna"), sol: model("sol"), astra: model("astra") };
const auto = { ...model("auto", "routing"), api: "pi-virtual" } as Model<Api>;
const usage: Usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 },
};
const sample: ClassifierUsage = { provider: "fixture", model: "classifier", usage };
const classified: ClassifierResult = {
	tier: "luna",
	reason: "Known narrow task",
	insufficient_context: false,
	latencyMs: 7,
};
const fallback: ClassifierResult = {
	tier: "sol",
	reason: "Unavailable classifier",
	insufficient_context: true,
	latencyMs: 10,
	fallback: "timeout",
};

function settings(): RoutingSettings {
	const ref = (id: string) => ({ provider: "fixture", id });
	return {
		version: 1,
		classifier: ref("classifier"),
		tiers: { luna: ref("luna"), sol: ref("sol"), astra: ref("astra") },
		subagents: true,
		timeoutMs: 2_000,
		maxTokens: 256,
	};
}
function user(content = "Correct the specified typo", timestamp = 1): Message {
	return { role: "user", content, timestamp };
}
function assistant(content = "Previous answer"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: models.sol.api,
		provider: "fixture",
		model: "sol",
		usage,
		stopReason: "stop",
		timestamp: 2,
	};
}
function request(overrides: Partial<ModelRouteRequest<RoutingState>> = {}): ModelRouteRequest<RoutingState> {
	return { model: auto, thinkingLevel: "high", reason: "user", messages: [user()], ...overrides };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
type Call = { model: Model<Api>; envelope: TaskEnvelope; options: ClassifierOptions };
function harness(
	options: {
		classify?: typeof classifyTask;
		result?: ClassifierResult;
		missingUsage?: boolean;
		loadSettings?: () => Promise<RoutingSettings | undefined>;
	} = {},
) {
	const catalog = new Map(Object.values(models).map((item) => [item.id, item]));
	const denied = new Set<string>();
	const dispatches: Call[] = [];
	const samples: { session: string; sample: ClassifierUsage }[] = [];
	const missing: string[] = [];
	const decisions: unknown[] = [];
	const classify: typeof classifyTask =
		options.classify ??
		(async (_registry, selected, envelope, config = {}) => {
			config.signal?.throwIfAborted();
			if (!envelope.task.trim()) return { ...fallback, fallback: "insufficient-context" };
			dispatches.push({ model: selected, envelope, options: config });
			config.onStarted?.();
			try {
				if (!options.missingUsage) config.onUsage?.(sample);
				return options.result ?? classified;
			} finally {
				config.onSettled?.();
			}
		});
	const registry = {
		find: (provider: string, id: string) => (provider === "fixture" ? catalog.get(id) : undefined),
		hasConfiguredAuth: (selected: Model<Api>) => !denied.has(selected.id),
	};
	const assessments = new Map<string, AssessmentRequest>();
	const queue = (mode: AssessmentRequest["mode"] = "reassess", id = "session", key = "assessment-1") =>
		assessments.set(id, { version: 1, id: key, mode });
	const context = (id = "session") =>
		({
			sessionManager: {
				getSessionId: () => id,
				getBranch: () =>
					assessments.has(id) ? [{ type: "custom", customType: ASSESSMENT_ENTRY, data: assessments.get(id) }] : [],
			},
			modelRegistry: registry,
		}) as unknown as ExtensionContext;
	const router = new TaskRouter({
		loadSettings: options.loadSettings ?? (async () => settings()),
		classify,
		onUsage: (ctx, value) => {
			samples.push({ session: ctx.sessionManager.getSessionId(), sample: value });
		},
		onMissingUsage: (ctx) => {
			missing.push(ctx.sessionManager.getSessionId());
		},
		onDecision: (_ctx, decision) => {
			decisions.push(decision);
		},
	});
	return { router, context, catalog, denied, dispatches, samples, missing, decisions, queue };
}

test("new user tasks classify once to the configured physical tier and preserve the selected thinking level", async () => {
	const h = harness();
	const ctx = h.context();
	const routed = await h.router.route(request(), ctx);
	expect(routed.model).toBe(models.luna);
	expect(routed.thinkingLevel).toBe("high");
	expect(routed.state).toMatchObject({
		version: 1,
		task: "Correct the specified typo",
		tier: "luna",
		model: { provider: "fixture", id: "luna" },
		reason: classified.reason,
	});
	expect(isRoutingState(routed.state)).toBe(true);
	expect(h.dispatches).toHaveLength(1);
	expect(h.dispatches[0]).toMatchObject({
		model: models.classifier,
		envelope: { task: "Correct the specified typo" },
		options: { timeoutMs: 2_000, maxTokens: 256 },
	});
	expect(h.samples).toEqual([{ session: "session", sample }]);
	expect(h.missing).toEqual([]);
	expect(h.router.hasPending(ctx)).toBe(false);
	expect(h.decisions).toHaveLength(1);
});

test("repeated user preflight uses its persisted task key without a second classification", async () => {
	const h = harness();
	const ctx = h.context();
	const first = await h.router.route(request(), ctx);
	const next = await h.router.route(request({ state: first.state, messages: [user(), assistant()] }), ctx);
	expect(next.model).toBe(first.model);
	expect(next.state).toBe(first.state);
	expect(h.dispatches).toHaveLength(1);
});

test("continuations, retries, and direct calls never reclassify and prefer failed over previous model", async () => {
	const h = harness({
		loadSettings: async () => {
			throw new Error("must not load settings");
		},
	});
	for (const reason of ["continuation", "retry", "direct"] as const) {
		const result = await h.router.route(
			request({
				reason,
				previous: { model: models.luna, thinkingLevel: "low" },
				failed: { model: models.astra, thinkingLevel: "medium", message: assistant() },
			}),
			h.context(),
		);
		expect(result.model).toBe(models.astra);
		expect(result.thinkingLevel).toBe("medium");
		const previous = await h.router.route(
			request({ reason, previous: { model: models.luna, thinkingLevel: "low" } }),
			h.context(),
		);
		expect(previous.model).toBe(models.luna);
		expect(previous.thinkingLevel).toBe("low");
	}
	expect(h.dispatches).toHaveLength(0);
});

test("non-user requests use persisted state or Sol when there is no physical history", async () => {
	const h = harness();
	const ctx = h.context();
	const first = await h.router.route(request(), ctx);
	for (const reason of ["continuation", "retry", "direct"] as const) {
		const inherited = await h.router.route(request({ reason, state: first.state, previous: { model: auto } }), ctx);
		expect(inherited.model).toBe(models.luna);
		expect(inherited.state).toBe(first.state);
		const fresh = await h.router.route(request({ reason }), ctx);
		expect(fresh.model).toBe(models.sol);
		expect(fresh.state).toBeUndefined();
	}
	expect(h.dispatches).toHaveLength(1);
});

test("each distinct user turn is reassessed, but same-tier/lower results retain the held model", async () => {
	const h = harness();
	const ctx = h.context();
	const first = await h.router.route(request(), ctx);
	let latest = first;
	for (const [index, content] of ["yes", "OK!", "go ahead", "continue", "Keep going."].entries()) {
		const next = await h.router.route(
			request({ state: latest.state, messages: [user(), assistant(), user(content, index + 3)] }),
			ctx,
		);
		latest = next;
		expect(next.model).toBe(first.model);
		expect(next.state?.tier).toBe(first.state?.tier);
		expect(next.state?.model).toEqual(first.state?.model);
		expect(next.thinkingLevel).toBe("high");
	}
	expect(h.dispatches).toHaveLength(6);
	const repeated = request({
		state: latest.state,
		messages: [user("Continue by redesigning the recovery protocol", 4)],
	});
	const newTurn = await h.router.route(repeated, ctx);
	expect(h.dispatches).toHaveLength(7);
	const duplicate = await h.router.route({ ...repeated, state: newTurn.state }, ctx);
	expect(duplicate.state).toBe(newTurn.state);
	expect(h.dispatches).toHaveLength(7);
	h.queue();
	await h.router.route(request({ state: duplicate.state, messages: [user("Assess the recovery redesign", 5)] }), ctx);
	expect(h.dispatches).toHaveLength(8);
	expect(h.dispatches[1].envelope.context).toContain("Previous task:");
});

test("automatic reassessment upgrades cumulative active work but never downgrades", async () => {
	const tiers = ["luna", "sol", "luna", "astra"] as const;
	const tasks: string[] = [];
	const h = harness({
		classify: async (_registry, _selected, envelope, config = {}) => {
			const tier = tiers[tasks.length] ?? "astra";
			tasks.push(envelope.task);
			config.onStarted?.();
			config.onUsage?.(sample);
			config.onSettled?.();
			return { ...classified, tier, reason: `Turn ${tasks.length} requires ${tier}.` };
		},
	});
	const ctx = h.context();
	const first = await h.router.route(request({ messages: [user("Fix a local typo", 1)] }), ctx);
	expect(first.state?.tier).toBe("luna");
	const second = await h.router.route(
		request({
			state: first.state,
			messages: [user("Now integrate authentication with retries across the service", 2)],
		}),
		ctx,
	);
	expect(second.state?.tier).toBe("sol");
	expect(second.model).toBe(models.sol);
	const simpler = await h.router.route(
		request({ state: second.state, messages: [user("Add a focused test for the new flow", 3)] }),
		ctx,
	);
	expect(simpler.state?.tier).toBe("sol");
	expect(simpler.model).toBe(models.sol);
	const complex = await h.router.route(
		request({
			state: simpler.state,
			messages: [user("Now resolve the cross-service partial-failure and ordering behavior", 4)],
		}),
		ctx,
	);
	expect(complex.state?.tier).toBe("astra");
	expect(complex.model).toBe(models.astra);
	expect(complex.state?.task).toContain("integrate authentication");
	expect(complex.state?.task).toContain("partial-failure");
	expect(tasks).toHaveLength(4);
	expect(h.samples).toHaveLength(4);
});

test("ambiguity retains an existing strong physical model and original task, but fresh ambiguity uses Sol", async () => {
	const h = harness({ result: { ...classified, tier: "sol", insufficient_context: true, reason: "Missing scope" } });
	const ctx = h.context();
	const old: RoutingState = {
		version: 1,
		taskKey: "old",
		task: "Existing bounded task",
		tier: "astra",
		model: { provider: "fixture", id: "astra" },
		reason: "Existing decision",
	};
	h.queue();
	const retained = await h.router.route(request({ state: old, messages: [user("Fix it", 3)] }), ctx);
	expect(retained.model).toBe(models.astra);
	expect(retained.state).toMatchObject({ tier: "astra", model: old.model });
	expect(retained.state?.task).toContain(old.task);
	expect(retained.state?.reason).toContain("retaining session model");
	expect(retained.state?.taskKey).not.toBe(old.taskKey);
	const fresh = await h.router.route(request({ messages: [user("Fix it")] }), h.context("new"));
	expect(fresh.model).toBe(models.sol);
	expect(fresh.state?.tier).toBe("sol");
});

test("session independence is provided by request state, not a process-global active route", async () => {
	const h = harness();
	const one = await h.router.route(request(), h.context("one"));
	const two = await h.router.route(request({ reason: "direct" }), h.context("two"));
	expect(one.model).toBe(models.luna);
	expect(two.model).toBe(models.sol);
	expect(h.router.hasPending(h.context("one"))).toBe(false);
	expect(h.router.hasPending(h.context("two"))).toBe(false);
});

test("timeout fallback leaves late classifier transport pending until usage arrives before settlement", async () => {
	const transport = deferred<void>();
	const order: string[] = [];
	const h = harness({
		classify: async (_registry, _model, _envelope, options = {}) => {
			options.onStarted?.();
			void transport.promise.then(() => {
				order.push("usage");
				options.onUsage?.(sample);
				order.push("settled");
				options.onSettled?.();
			});
			return fallback;
		},
	});
	const ctx = h.context();
	const routed = await h.router.route(request(), ctx);
	expect(routed.model).toBe(models.sol);
	expect(h.router.hasPending(ctx)).toBe(true);
	expect(h.router.hasPending(h.context("other"))).toBe(false);
	expect(h.samples).toEqual([]);
	expect(h.missing).toEqual([]);
	transport.resolve();
	await transport.promise;
	expect(order).toEqual(["usage", "settled"]);
	expect(h.samples).toEqual([{ session: "session", sample }]);
	expect(h.missing).toEqual([]);
	expect(h.router.hasPending(ctx)).toBe(false);
	expect(h.decisions[0]).toMatchObject({ fallback: "timeout" });
});

test("pending counters isolate concurrent sessions and require every same-session transport to settle", async () => {
	const callbacks: ClassifierOptions[] = [];
	const h = harness({
		classify: async (_registry, _model, _envelope, options = {}) => {
			options.onStarted?.();
			callbacks.push(options);
			return fallback;
		},
	});
	const one = h.context("one");
	const two = h.context("two");
	await Promise.all([
		h.router.subtask({ task: "A" }, one),
		h.router.subtask({ task: "B" }, one),
		h.router.subtask({ task: "C" }, two),
	]);
	expect(h.router.hasPending(one)).toBe(true);
	expect(h.router.hasPending(two)).toBe(true);
	callbacks[0].onUsage?.(sample);
	callbacks[0].onSettled?.();
	callbacks[0].onSettled?.(); // Defensive idempotence must not decrement another transport.
	expect(h.router.hasPending(one)).toBe(true);
	callbacks[2].onSettled?.();
	expect(h.router.hasPending(two)).toBe(false);
	expect(h.router.hasPending(one)).toBe(true);
	callbacks[1].onSettled?.();
	expect(h.router.hasPending(one)).toBe(false);
	expect(h.missing.sort()).toEqual(["one", "two"]);
});

test("transport rejection releases pending and emits missing-usage only after actual settlement", async () => {
	const completion = deferred<ClassifierResult>();
	const h = harness({
		classify: async (_registry, _model, _envelope, options = {}) => {
			options.onStarted?.();
			try {
				return await completion.promise;
			} finally {
				options.onSettled?.();
			}
		},
	});
	const ctx = h.context();
	const result = h.router.route(request(), ctx);
	const rejected = result.catch((error: unknown) => error);
	await Promise.resolve();
	await Promise.resolve();
	completion.reject(new Error("transport failed"));
	expect(await rejected).toMatchObject({ message: "transport failed" });
	expect(h.router.hasPending(ctx)).toBe(false);
	expect(h.missing).toEqual(["session"]);
});

test("empty task does not dispatch or leave a pending classifier transport", async () => {
	const h = harness();
	const ctx = h.context();
	const routed = await h.router.route(request({ messages: [] }), ctx);
	expect(routed.model).toBe(models.sol);
	expect(h.dispatches).toHaveLength(0);
	expect(h.router.hasPending(ctx)).toBe(false);
	expect(h.missing).toEqual([]);
});

test("pre-aborted requests and abort during settings load never dispatch or leave pending flags", async () => {
	const aborted = new AbortController();
	aborted.abort();
	const early = harness();
	await expect(early.router.route(request({ signal: aborted.signal }), early.context())).rejects.toThrow();
	expect(early.dispatches).toHaveLength(0);
	expect(early.router.hasPending(early.context())).toBe(false);
	const loading = deferred<RoutingSettings>();
	const h = harness({ loadSettings: () => loading.promise });
	const operation = new AbortController();
	const ctx = h.context();
	const pending = h.router.route(request({ signal: operation.signal }), ctx);
	const rejected = pending.catch((error: unknown) => error);
	operation.abort();
	loading.resolve(settings());
	expect(await rejected).toMatchObject({ name: "AbortError" });
	expect(h.dispatches).toHaveLength(0);
	expect(h.router.hasPending(ctx)).toBe(false);
	expect(h.missing).toEqual([]);
});

test("missing, virtual, or unauthenticated configured physical targets fail without silent provider substitution", async () => {
	for (const target of ["sol", "luna"]) {
		for (const failure of ["missing", "virtual", "auth"]) {
			const h = harness();
			if (failure === "missing") h.catalog.delete(target);
			if (failure === "virtual") h.catalog.set(target, { ...models.sol, id: target, api: "pi-virtual" } as Model<Api>);
			if (failure === "auth") h.denied.add(target);
			const ctx = h.context();
			await expect(h.router.route(request(), ctx)).rejects.toThrow(
				failure === "auth" ? "authentication" : "physical model",
			);
			expect(h.router.hasPending(ctx)).toBe(false);
			expect(h.decisions).toHaveLength(0);
			expect(h.dispatches).toHaveLength(target === "luna" ? 1 : 0);
		}
	}
});

test("an unavailable classifier falls back to configured Sol without dispatch or pending transport", async () => {
	for (const failure of ["missing", "virtual", "auth"]) {
		const h = harness();
		if (failure === "missing") h.catalog.delete("classifier");
		if (failure === "virtual") h.catalog.set("classifier", { ...models.classifier, api: "pi-virtual" } as Model<Api>);
		if (failure === "auth") h.denied.add("classifier");
		const ctx = h.context();
		const result = await h.router.route(request(), ctx);
		expect(result.model).toBe(models.sol);
		expect(h.dispatches).toHaveLength(0);
		expect(h.router.hasPending(ctx)).toBe(false);
		expect(h.decisions[0]).toMatchObject({ fallback: "classifier-unavailable" });
	}
});

test("unconfigured routing gives an actionable setup error and never dispatches", async () => {
	const h = harness({ loadSettings: async () => undefined });
	await expect(h.router.route(request(), h.context())).rejects.toThrow("/routing setup");
	expect(h.dispatches).toHaveLength(0);
});

test("subtasks classify independently, preserve envelope fields, and conservatively map insufficient Luna context to Sol", async () => {
	const h = harness({ result: { ...classified, tier: "luna", insufficient_context: true } });
	const envelope: TaskEnvelope = {
		task: "Fix the supplied module",
		context: "Known constraints",
		knownScope: ["module.ts"],
		expectedOutput: "One patch",
		uncertainties: ["Unknown behavior"],
	};
	const result = await h.router.subtask(envelope, h.context());
	expect(result.model).toEqual({ provider: "fixture", id: "sol" });
	expect(h.dispatches[0].envelope).toBe(envelope);
	expect(h.decisions[0]).toMatchObject({ kind: "subagent", task: envelope.task, tier: "sol" });
});

test("explicit hard-scope evidence keeps Astra despite missing details for main requests and subtasks", async () => {
	const h = harness({ result: { ...classified, tier: "astra", insufficient_context: true } });
	const ctx = h.context();
	const old: RoutingState = {
		version: 1,
		taskKey: "old",
		task: "Old local task",
		tier: "luna",
		model: { provider: "fixture", id: "luna" },
		reason: "Known scope",
	};
	h.queue();
	const task = "Diagnose lost concurrent writes after failover; incident logs are not supplied";
	for (const state of [undefined, old]) {
		const routed = await h.router.route(request({ state, messages: [user(task)] }), ctx);
		expect(routed.model).toBe(models.astra);
		expect(routed.state?.tier).toBe("astra");
	}
	expect((await h.router.subtask({ task }, ctx)).model).toEqual({ provider: "fixture", id: "astra" });
});

test("ambiguous followups retain Luna while still classifying each new turn", async () => {
	const h = harness({ result: { ...classified, tier: "luna", insufficient_context: true } });
	const old: RoutingState = {
		version: 1,
		taskKey: "old",
		task: "Old local task",
		tier: "luna",
		model: { provider: "fixture", id: "luna" },
		reason: "Known scope",
	};
	const ctx = h.context();
	const routed = await h.router.route(request({ state: old, messages: [user("Fix the other issue")] }), ctx);
	expect(routed.model).toBe(models.luna);
	expect(routed.state?.tier).toBe("luna");
	const acknowledgement = await h.router.route(
		request({ state: routed.state, messages: [user("yes")], thinkingLevel: "low" }),
		ctx,
	);
	expect(acknowledgement.model).toBe(models.luna);
	expect(acknowledgement.thinkingLevel).toBe("low");
	expect(h.dispatches).toHaveLength(2);
	expect(h.samples).toHaveLength(2);
});

test("task envelopes include bounded conversational context, ignore tool results, and expose image uncertainty", () => {
	const image: Message = {
		role: "user",
		timestamp: 3,
		content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
	};
	const extracted = taskEnvelope([
		user("Known task"),
		assistant(),
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "untrusted tool body" }],
			isError: false,
			timestamp: 2,
		},
		image,
	]);
	expect(extracted.envelope.task).toContain("contents have not been classified");
	expect(extracted.envelope.context).toContain("Known task");
	expect(extracted.envelope.context).not.toContain("untrusted tool body");
	expect(taskEnvelope([user("x".repeat(20_000))]).envelope.task).toHaveLength(12_000);
	expect(taskEnvelope([user("First", 1)]).key).not.toBe(taskEnvelope([user("First", 2)]).key);
});

test("route/state guards reject malformed persisted state and recognise only the Auto identity", () => {
	expect(isAuto(auto)).toBe(true);
	expect(isAuto(models.sol)).toBe(false);
	expect(isAuto(undefined)).toBe(false);
	for (const state of [
		undefined,
		null,
		{},
		{ version: 2 },
		{
			version: 1,
			taskKey: "key",
			task: "task",
			tier: "unknown",
			model: { provider: "fixture", id: "sol" },
			reason: "reason",
		},
	])
		expect(isRoutingState(state)).toBe(false);
	expect(
		isRoutingState({
			version: 1,
			taskKey: "key",
			task: "task",
			tier: "sol",
			model: { provider: "fixture", id: "sol" },
			reason: "why",
			assessmentId: 42,
		}),
	).toBe(false);
	const h = harness();
	expect(physicalModel({ provider: "fixture", id: "sol" }, h.context())).toBe(models.sol);
});

test("twenty substantive follow-ups are classified once each without tool-continuation calls", async () => {
	const h = harness();
	const ctx = h.context();
	const first = await h.router.route(request(), ctx);
	let latest = first;
	for (let i = 0; i < 20; i++) {
		const next = await h.router.route(
			request({
				state: latest.state,
				messages: [user(`Add tests, investigate failure paths, and finish implementation ${i}`, i + 10)],
				thinkingLevel: "low",
			}),
			ctx,
		);
		expect(next.model).toBe(first.model);
		expect(next.state?.model).toEqual(first.state?.model);
		expect(next.thinkingLevel).toBe("low");
		latest = next;
	}
	expect(h.dispatches).toHaveLength(21);
	expect(h.samples).toHaveLength(21);
	expect(h.decisions).toHaveLength(21);
});

test("reassessment is upgrade-only; reset explicitly permits downgrades, once per request", async () => {
	for (const mode of ["reassess", "reset"] as const) {
		for (const current of ["luna", "sol", "astra"] as const) {
			for (const proposed of ["luna", "sol", "astra"] as const) {
				const h = harness({ result: { ...classified, tier: proposed } });
				const state: RoutingState = {
					version: 1,
					taskKey: "old",
					task: "Existing work",
					tier: current,
					model: { provider: "fixture", id: current },
					reason: "Initial route",
				};
				h.queue(mode);
				const ctx = h.context();
				const next = await h.router.route(request({ state }), ctx);
				const rank = { luna: 0, sol: 1, astra: 2 };
				const expected = mode === "reset" || rank[proposed] > rank[current] ? proposed : current;
				expect(next.model).toBe(models[expected]);
				expect(next.state?.assessmentId).toBe("assessment-1");
				const replay = await h.router.route(request({ state: next.state }), ctx);
				expect(replay.state).toBe(next.state);
				expect(h.dispatches).toHaveLength(1);
				expect(h.samples).toHaveLength(1);
				h.queue(mode, "session", "assessment-2");
				await h.router.route(request({ state: next.state }), ctx);
				expect(h.dispatches).toHaveLength(2);
			}
		}
	}
});

test("same-tier reassessment keeps the exact model despite remapped preferences", async () => {
	const prefs = settings();
	prefs.tiers.sol = prefs.tiers.astra;
	const h = harness({ result: { ...classified, tier: "sol" }, loadSettings: async () => prefs });
	const state: RoutingState = {
		version: 1,
		taskKey: "old",
		task: "Existing work",
		tier: "sol",
		model: { provider: "fixture", id: "sol" },
		reason: "Initial route",
	};
	h.queue();
	const next = await h.router.route(request({ state }), h.context());
	expect(next.model).toBe(models.sol);
	expect(next.state?.reason).toContain("No tier upgrade");
	h.queue("reset", "session", "reset");
	expect((await h.router.route(request({ state: next.state }), h.context())).model).toBe(models.astra);
});

test("failed or ambiguous explicit assessments retain every existing tier and consume the request", async () => {
	for (const current of ["luna", "sol", "astra"] as const) {
		for (const result of [fallback, { ...classified, tier: "sol" as const, insufficient_context: true }]) {
			for (const mode of ["reassess", "reset"] as const) {
				const h = harness({ result });
				const state: RoutingState = {
					version: 1,
					taskKey: "old",
					task: "Existing work",
					tier: current,
					model: { provider: "fixture", id: current },
					reason: "Initial route",
				};
				h.queue(mode);
				const next = await h.router.route(request({ state }), h.context());
				expect(next.model).toBe(models[current]);
				expect(next.state?.assessmentId).toBe("assessment-1");
				expect(next.state?.reason).toContain("Unreliable assessment");
				await h.router.route(request({ state: next.state }), h.context());
				expect(h.dispatches).toHaveLength(1);
			}
		}
	}
});

test("aborted reassessment leaves its request unconsumed and retry/summary calls never consume it", async () => {
	const h = harness();
	const ctx = h.context();
	const first = await h.router.route(request(), ctx);
	h.queue("reset");
	const abort = new AbortController();
	abort.abort();
	await expect(h.router.route(request({ state: first.state, signal: abort.signal }), ctx)).rejects.toThrow();
	expect(first.state?.assessmentId).toBeUndefined();
	for (const reason of ["retry", "continuation", "direct"] as const) {
		const sticky = await h.router.route(request({ reason, state: first.state }), ctx);
		expect(sticky.state).toBe(first.state);
	}
	expect(h.dispatches).toHaveLength(1);
	const next = await h.router.route(request({ state: first.state }), ctx);
	expect(next.state?.assessmentId).toBe("assessment-1");
	expect(h.dispatches).toHaveLength(2);
});

test("unavailable pinned model fails visibly without spending on classification or substituting", async () => {
	const h = harness();
	const ctx = h.context();
	const first = await h.router.route(request(), ctx);
	h.denied.add("luna");
	await expect(h.router.route(request({ state: first.state }), ctx)).rejects.toThrow("authentication");
	h.queue("reset");
	await expect(h.router.route(request({ state: first.state }), ctx)).rejects.toThrow("authentication");
	expect(h.dispatches).toHaveLength(1);
});

test("cancellation after dispatch records spend but does not consume reassessment", async () => {
	const controller = new AbortController();
	let cancel = true;
	const h = harness({
		classify: async (_registry, _model, _task, options = {}) => {
			options.onStarted?.();
			try {
				options.onUsage?.(sample);
				if (cancel) controller.abort();
				return { ...classified, tier: "astra" };
			} finally {
				options.onSettled?.();
			}
		},
	});
	const state: RoutingState = {
		version: 1,
		taskKey: "old",
		task: "Existing work",
		tier: "sol",
		model: { provider: "fixture", id: "sol" },
		reason: "Initial route",
	};
	h.queue();
	await expect(h.router.route(request({ state, signal: controller.signal }), h.context())).rejects.toThrow();
	expect(state.assessmentId).toBeUndefined();
	expect(h.decisions).toHaveLength(0);
	expect(h.samples).toHaveLength(1);
	expect(h.router.hasPending(h.context())).toBe(false);
	cancel = false;
	const next = await h.router.route(request({ state }), h.context());
	expect(next.state).toMatchObject({ tier: "astra", assessmentId: "assessment-1" });
	expect(h.samples).toHaveLength(2);
});

test("one session's pending reassessment does not classify another session's held route", async () => {
	const h = harness({ result: { ...classified, tier: "astra" } });
	const ctx = h.context("two");
	const state = (await h.router.route(request(), ctx)).state!;
	h.queue("reset", "one");
	const repeatedRequest = request({ state });
	const other = await h.router.route(repeatedRequest, ctx);
	expect(other.state).toBe(state);
	expect(other.model).toBe(models.astra);
	expect(h.dispatches).toHaveLength(1);
	const changed = await h.router.route(repeatedRequest, h.context("one"));
	expect(changed.model).toBe(models.astra);
	expect(h.dispatches).toHaveLength(2);
});

test("shutdown marks only its unsettled classifier spend unknown, once, and suppresses late accounting", async () => {
	const pending: { done: ReturnType<typeof deferred<ClassifierResult>>; options: ClassifierOptions }[] = [];
	const h = harness({
		classify: async (_registry, _model, _envelope, options = {}) => {
			const done = deferred<ClassifierResult>();
			pending.push({ done, options });
			options.onStarted?.();
			try {
				return await done.promise;
			} finally {
				options.onSettled?.();
			}
		},
	});
	const one = h.context("one");
	const two = h.context("two");
	const first = h.router.subtask({ task: "First assignment" }, one);
	const second = h.router.subtask({ task: "Second assignment" }, two);
	await Promise.resolve();
	await Promise.resolve();
	expect(h.router.hasPending(one)).toBe(true);
	expect(h.router.hasPending(two)).toBe(true);
	h.router.close(one);
	h.router.close(one);
	expect(h.missing).toEqual(["one"]);
	expect(h.router.hasPending(one)).toBe(false);
	expect(h.router.hasPending(two)).toBe(true);
	pending[0].options.onUsage?.(sample);
	pending[0].done.resolve(classified);
	pending[1].options.onUsage?.(sample);
	pending[1].done.resolve(classified);
	await Promise.all([first, second]);
	expect(h.samples.map((entry) => entry.session)).toEqual(["two"]);
	expect(h.missing).toEqual(["one"]);
	expect(h.router.hasPending(two)).toBe(false);
});

test("reset starts a fresh cumulative scope instead of carrying completed work or clipping flags", async () => {
	const h = harness();
	const old: RoutingState = {
		version: 1,
		taskKey: "old",
		task: "Completed distributed recovery redesign",
		taskTruncated: true,
		tier: "astra",
		model: { provider: "fixture", id: "astra" },
		reason: "Previous work",
	};
	h.queue("reset");
	const fresh = await h.router.route(request({ state: old, messages: [user("Fix the supplied typo")] }), h.context());
	expect(fresh.state?.task).toBe("Fix the supplied typo");
	expect(fresh.state?.taskTruncated).toBeUndefined();
	expect(h.dispatches[0].envelope.context).toBeUndefined();
	expect(h.dispatches[0].envelope.truncated).toBeUndefined();
	expect(taskEnvelope([user("Continue")], old).envelope.truncated).toBe(true);
});
