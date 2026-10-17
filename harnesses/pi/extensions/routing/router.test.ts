import { expect, test } from "bun:test";
import type { Api, AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { ClassifierOptions, classifyTask } from "./classifier.js";
import {
	isAcknowledgement,
	isAuto,
	isRoutingState,
	physicalModel,
	type RoutingState,
	TaskRouter,
	taskEnvelope,
} from "./router.js";
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
	const context = (id = "session") =>
		({ sessionManager: { getSessionId: () => id }, modelRegistry: registry }) as unknown as ExtensionContext;
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
	return { router, context, catalog, denied, dispatches, samples, missing, decisions };
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

test("acknowledgements keep the active task while materially new task text reclassifies", async () => {
	const h = harness();
	const ctx = h.context();
	const first = await h.router.route(request(), ctx);
	for (const content of ["yes", "OK!", "go ahead", "continue", "Keep going."]) {
		const next = await h.router.route(
			request({ state: first.state, messages: [user(), assistant(), user(content, 3)] }),
			ctx,
		);
		expect(next.model).toBe(first.model);
		expect(next.state).toBe(first.state);
		expect(next.thinkingLevel).toBe("high");
	}
	expect(h.dispatches).toHaveLength(1);
	await h.router.route(
		request({ state: first.state, messages: [user("Continue by redesigning the recovery protocol", 4)] }),
		ctx,
	);
	expect(h.dispatches).toHaveLength(2);
	expect(h.dispatches[1].envelope.context).toContain("Previous task:");
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
	const retained = await h.router.route(request({ state: old, messages: [user("Fix it", 3)] }), ctx);
	expect(retained.model).toBe(models.astra);
	expect(retained.state).toMatchObject({ tier: "astra", task: old.task, model: old.model });
	expect(retained.state?.reason).toContain("retaining previous task model");
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
	const task = "Diagnose lost concurrent writes after failover; incident logs are not supplied";
	for (const state of [undefined, old]) {
		const routed = await h.router.route(request({ state, messages: [user(task)] }), ctx);
		expect(routed.model).toBe(models.astra);
		expect(routed.state?.tier).toBe("astra");
	}
	expect((await h.router.subtask({ task }, ctx)).model).toEqual({ provider: "fixture", id: "astra" });
});

test("ambiguous followups cannot remain on Luna unless they are exact acknowledgements", async () => {
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
	expect(routed.model).toBe(models.sol);
	expect(routed.state?.tier).toBe("sol");
	const acknowledgement = await h.router.route(
		request({ state: old, messages: [user("yes")], thinkingLevel: "low" }),
		ctx,
	);
	expect(acknowledgement.model).toBe(models.luna);
	expect(acknowledgement.thinkingLevel).toBe("low");
	expect(h.dispatches).toHaveLength(1);
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
	for (const task of ["yes!", " OK ", "proceed."]) expect(isAcknowledgement(task)).toBe(true);
	for (const task of ["", "yes, but change the API", "continue refactoring", "no"])
		expect(isAcknowledgement(task)).toBe(false);
	const h = harness();
	expect(physicalModel({ provider: "fixture", id: "sol" }, h.context())).toBe(models.sol);
});
