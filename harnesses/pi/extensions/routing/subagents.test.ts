import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSubagentRouting, type SubagentRoutingController } from "./subagents.js";

const selection = { model: { provider: "vendor", id: "worker" }, reason: "bounded task" };
type Selection = typeof selection;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function context(id = "session", signal?: AbortSignal): ExtensionContext {
	return { sessionManager: { getSessionId: () => id }, signal } as ExtensionContext;
}

function spawn(overrides: Record<string, unknown> = {}, id = "call") {
	return {
		type: "tool_call" as const,
		toolName: "spawn_agent",
		toolCallId: id,
		input: { task_name: "worker", message: "Inspect the isolated module", fork_turns: "none", ...overrides } as Record<
			string,
			unknown
		>,
	};
}

function harness(route: SubagentRoutingController["route"] = async () => selection) {
	const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const requests: { task: unknown; ctx: ExtensionContext; signal?: AbortSignal }[] = [];
	const decisions: unknown[] = [];
	let enabled = true;
	const controller: SubagentRoutingController = {
		isEnabled: () => enabled,
		route: (task, ctx, signal) => {
			requests.push({ task, ctx, signal });
			return route(task, ctx, signal);
		},
		onDecision: (_ctx, decision) => {
			decisions.push(decision);
		},
	};
	registerSubagentRouting(
		{
			on: (name: string, hook: any) => {
				hooks.set(name, hook);
			},
		} as Pick<ExtensionAPI, "on">,
		controller,
	);
	return {
		requests,
		decisions,
		controller,
		enable: (value: boolean) => {
			enabled = value;
		},
		call: (event: ReturnType<typeof spawn>, ctx = context()) => hooks.get("tool_call")!(event, ctx),
		lifecycle: (name: string, ctx: ExtensionContext, reason = "reload") =>
			hooks.get(name)!({ type: name, reason }, ctx),
	};
}

test("patches only model in place before native tool invocation", async () => {
	const h = harness();
	const ctx = context();
	for (const fork_turns of ["none", "1", "3", " 2 "]) {
		const event = spawn({ fork_turns, thinking_level: "high" }, fork_turns);
		const original = { ...event.input };
		const args = event.input;
		expect(await h.call(event, ctx)).toBeUndefined();
		expect(event.input).toBe(args);
		expect(args).toEqual({ ...original, model: "vendor/worker" });
	}
	expect(h.requests).toHaveLength(4);
	expect(h.requests[0].task).toEqual({ task: "Inspect the isolated module" });
	expect(h.decisions[0]).toEqual({ kind: "subagent", task: "Inspect the isolated module", ...selection });
});

test("disabled parents, followups, and unrelated tools do not classify or change arguments", async () => {
	const h = harness();
	h.enable(false);
	const event = spawn();
	expect(await h.call(event)).toBeUndefined();
	h.enable(true);
	for (const toolName of ["followup_task", "spawn_lane", "send_message", "read"]) {
		const other = { ...spawn(), toolName };
		const before = structuredClone(other);
		expect(await h.call(other)).toBeUndefined();
		expect(other).toEqual(before);
	}
	expect(h.requests).toHaveLength(0);
	expect(event.input.model).toBeUndefined();
});

test("explicit models always bypass routing, even frozen or invalid choices", async () => {
	const h = harness();
	for (const model of ["vendor/manual", "alias", "", null, 7, { provider: "vendor", id: "legacy" }]) {
		const event = spawn({ model, fork_turns: "invalid" });
		Object.freeze(event.input);
		expect(await h.call(event)).toBeUndefined();
		expect(event.input.model).toBe(model);
	}
	expect(h.requests).toHaveLength(0);
});

test("omitted, all, and legacy empty forks preserve full-history inheritance", async () => {
	const h = harness();
	for (const fork_turns of [undefined, "all", " all ", "", "  "]) {
		const event = spawn({ fork_turns });
		const before = { ...event.input };
		expect(await h.call(event)).toBeUndefined();
		expect(event.input).toEqual(before);
	}
	expect(h.requests).toHaveLength(0);
});

test("invalid fork specifications block without classifying or rewriting history", async () => {
	const h = harness();
	for (const fork_turns of [0, 2, null, true, "0", "-1", "1.5", "01", "1e2", "9007199254740992", "NONE"]) {
		const event = spawn({ fork_turns });
		expect(await h.call(event)).toMatchObject({ block: true });
		expect(event.input.fork_turns).toBe(fork_turns);
		expect(event.input.model).toBeUndefined();
	}
	expect(h.requests).toHaveLength(0);
});

test("immutable and legacy task arguments fail closed without classification", async () => {
	const h = harness();
	const frozen = spawn();
	Object.freeze(frozen.input);
	expect(await h.call(frozen)).toMatchObject({ block: true });
	const sealed = spawn();
	Object.seal(sealed.input);
	expect(await h.call(sealed)).toMatchObject({ block: true });
	expect(await h.call(spawn({ message: undefined, task: "legacy task" }))).toMatchObject({ block: true });
	expect(await h.call(spawn({ message: "   " }))).toMatchObject({ block: true });
	expect(h.requests).toHaveLength(0);
});

test("duplicate preflights and retries share a selection, not unrelated call IDs or tasks", async () => {
	const pending = deferred<Selection>();
	const h = harness(() => pending.promise);
	const ctx = context();
	const first = spawn();
	const duplicate = spawn();
	const a = h.call(first, ctx);
	const b = h.call(duplicate, { ...ctx });
	await Promise.resolve();
	expect(h.requests).toHaveLength(1);
	pending.resolve(selection);
	expect(await Promise.all([a, b])).toEqual([undefined, undefined]);
	const retry = spawn();
	await h.call(retry, ctx);
	expect(retry.input.model).toBe("vendor/worker");
	expect(h.requests).toHaveLength(1);
	expect(h.decisions).toHaveLength(1);
	await h.call(spawn({}, "unrelated"), ctx);
	await h.call(spawn({ message: "A different task" }), ctx);
	expect(h.requests).toHaveLength(3);
});

test("parallel runtime scopes and session IDs cannot reuse each other's decisions", async () => {
	const h = harness(async (_task, ctx) => ({
		...selection,
		model: { provider: "vendor", id: ctx.sessionManager.getSessionId() },
	}));
	let id = "one";
	const ctx = { sessionManager: { getSessionId: () => id } } as ExtensionContext;
	await h.call(spawn(), ctx);
	id = "two";
	const second = spawn();
	await h.call(second, ctx);
	expect(second.input.model).toBe("vendor/two");
	await h.call(spawn(), context("two"));
	expect(h.requests).toHaveLength(3);
});

test("session start resets assignment cache for new, resume, fork, and reload", async () => {
	const h = harness();
	const ctx = context();
	await h.call(spawn(), ctx);
	for (const reason of ["new", "resume", "fork", "reload"]) {
		await h.lifecycle("session_start", ctx, reason);
		await h.call(spawn(), ctx);
	}
	expect(h.requests).toHaveLength(5);
});

test("session shutdown cancels only its own pending work, and ignores late results", async () => {
	const pending = deferred<Selection>();
	const h = harness(() => pending.promise);
	const one = context("one");
	const two = context("two");
	const first = spawn();
	const second = spawn();
	const a = h.call(first, one);
	const b = h.call(second, two);
	await Promise.resolve();
	await h.lifecycle("session_shutdown", one);
	await h.lifecycle("session_shutdown", one);
	expect(await a).toMatchObject({ block: true });
	expect(h.requests[0].signal?.aborted).toBe(true);
	expect(h.requests[1].signal?.aborted).toBe(false);
	pending.resolve(selection);
	expect(await b).toBeUndefined();
	expect(first.input.model).toBeUndefined();
	expect(second.input.model).toBe("vendor/worker");
	expect(await h.call(spawn(), one)).toMatchObject({ block: true });
	expect(h.requests).toHaveLength(2);
	await h.lifecycle("session_start", one);
	await h.call(spawn(), one);
	expect(h.requests).toHaveLength(3);
});

test("session replacement cancels pending routing even without an operation signal", async () => {
	const pending = deferred<Selection>();
	const h = harness(() => pending.promise);
	const ctx = context();
	const event = spawn();
	const result = h.call(event, ctx);
	await Promise.resolve();
	await h.lifecycle("session_start", ctx, "resume");
	expect(await result).toMatchObject({ block: true });
	pending.resolve(selection);
	await Promise.resolve();
	expect(event.input.model).toBeUndefined();
});

test("aborted calls do not classify; abandoned routes abort and allow clean retries", async () => {
	const operation = new AbortController();
	operation.abort();
	const pending = deferred<Selection>();
	const h = harness(() => pending.promise);
	const ctx = context("session", operation.signal);
	expect(await h.call(spawn(), ctx)).toMatchObject({ block: true });
	expect(h.requests).toHaveLength(0);
	const active = new AbortController();
	const event = spawn();
	const result = h.call(event, { ...ctx, signal: active.signal });
	await Promise.resolve();
	active.abort();
	expect(await result).toMatchObject({ block: true });
	expect(h.requests[0].signal?.aborted).toBe(true);
	pending.resolve(selection);
	expect(event.input.model).toBeUndefined();
	const retry = spawn();
	expect(await h.call(retry, { ...ctx, signal: undefined })).toBeUndefined();
	expect(retry.input.model).toBe("vendor/worker");
	expect(h.requests).toHaveLength(2);
});

test("cancelling one duplicate waiter does not cancel the other waiter", async () => {
	const pending = deferred<Selection>();
	const h = harness(() => pending.promise);
	const operation = new AbortController();
	const ctx = context("session", operation.signal);
	const first = spawn();
	const second = spawn();
	const a = h.call(first, ctx);
	const b = h.call(second, { ...ctx, signal: undefined });
	await Promise.resolve();
	operation.abort();
	expect(await a).toMatchObject({ block: true });
	expect(h.requests[0].signal?.aborted).toBe(false);
	pending.resolve(selection);
	expect(await b).toBeUndefined();
	expect(first.input.model).toBeUndefined();
	expect(second.input.model).toBe("vendor/worker");
	expect(h.requests).toHaveLength(1);
});

test("route failures and invalid selections block rather than silently inherit", async () => {
	for (const route of [
		async () => {
			throw new Error("classification unavailable");
		},
		async () => ({ model: { provider: "", id: "bad" }, reason: "invalid" }),
	]) {
		const h = harness(route);
		const event = spawn();
		expect(await h.call(event)).toMatchObject({ block: true });
		expect(event.input.model).toBeUndefined();
		expect(h.decisions).toHaveLength(0);
	}
});

test("manual choice, disabled Auto, or changed arguments during routing cannot be overwritten", async () => {
	for (const change of ["manual", "disabled", "fork", "frozen"]) {
		const pending = deferred<Selection>();
		const h = harness(() => pending.promise);
		const event = spawn();
		const result = h.call(event);
		await Promise.resolve();
		if (change === "manual") event.input.model = "vendor/manual";
		if (change === "disabled") h.enable(false);
		if (change === "fork") event.input.fork_turns = "all";
		if (change === "frozen") Object.freeze(event.input);
		pending.resolve(selection);
		const outcome = await result;
		if (change === "fork" || change === "frozen") expect(outcome).toMatchObject({ block: true });
		else expect(outcome).toBeUndefined();
		expect(event.input.model).toBe(change === "manual" ? "vendor/manual" : undefined);
		expect(h.decisions).toHaveLength(0);
	}
});

test("decision notification failure blocks and removes the injected model", async () => {
	const h = harness();
	h.controller.onDecision = () => {
		throw new Error("notification failed");
	};
	const event = spawn();
	expect(await h.call(event)).toMatchObject({ block: true, reason: "notification failed" });
	expect(event.input.model).toBeUndefined();
});

test("a cancelled retry cannot evict an already completed assignment decision", async () => {
	const h = harness();
	const ctx = context();
	await h.call(spawn(), ctx);
	const operation = new AbortController();
	operation.abort();
	expect(await h.call(spawn(), { ...ctx, signal: operation.signal })).toMatchObject({ block: true });
	const retry = spawn();
	expect(await h.call(retry, ctx)).toBeUndefined();
	expect(retry.input.model).toBe("vendor/worker");
	expect(h.requests).toHaveLength(1);
});

test("duplicate asynchronous routing failures all block without mutating arguments", async () => {
	const pending = deferred<Selection>();
	const h = harness(() => pending.promise);
	const ctx = context();
	const first = spawn();
	const second = spawn();
	const a = h.call(first, ctx);
	const b = h.call(second, ctx);
	await Promise.resolve();
	pending.reject(new Error("classifier transport failed"));
	for (const outcome of await Promise.all([a, b])) {
		expect(outcome).toMatchObject({ block: true, reason: "classifier transport failed" });
	}
	expect(first.input.model).toBeUndefined();
	expect(second.input.model).toBeUndefined();
	expect(h.requests).toHaveLength(1);
});

test("routed qualified child models resolve natively under an Auto-only model scope", async () => {
	const h = harness();
	const auto = { provider: "routing", id: "auto", name: "Auto" };
	const worker = { ...selection.model, name: "Worker" };
	const ctx = {
		...context(),
		model: auto,
		scopedModels: [{ model: auto }],
		modelRegistry: { getAvailable: () => [auto, worker] },
	} as unknown as ExtensionContext;
	const event = spawn();
	expect(await h.call(event, ctx)).toBeUndefined();
	const runner = await import(new URL("./runtime/agent-runner.ts", import.meta.resolve("@luan.sh/pi-subagents")).href);
	expect(runner.resolveModel(ctx, event.input.model)).toBe(worker);
	// Short names remain scoped; qualified choices still require an available target.
	expect(() => runner.resolveModel(ctx, "worker")).toThrow("Unknown model");
	expect(() => runner.resolveModel(ctx, "vendor/unavailable")).toThrow("Unknown model");
	expect(runner.resolveModel(ctx, undefined)).toBe(auto);
});
