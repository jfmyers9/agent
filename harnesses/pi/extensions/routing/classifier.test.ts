import { expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model, StreamOptions, Usage } from "@earendil-works/pi-ai";
import { CLASSIFIER_PROMPT, classifyTask, parseClassification } from "./classifier";
import { ROUTING_EVALUATION_CASES } from "./evaluation";
import { taskEnvelope } from "./router";
import type { Classification, ClassifierUsage, TaskEnvelope } from "./types";

const model: Model<Api> = {
	provider: "fixture",
	id: "physical-luna",
	name: "Physical Luna",
	api: "openai-responses",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: true,
	contextWindow: 32_000,
	maxTokens: 4_096,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const usage: Usage = {
	input: 700,
	output: 30,
	cacheRead: 10,
	cacheWrite: 0,
	totalTokens: 740,
	cost: { input: 0.0007, output: 0.00003, cacheRead: 0, cacheWrite: 0, total: 0.00073 },
};
const label: Classification = { tier: "luna", reason: "Known local edit.", insufficient_context: false };
const envelope: TaskEnvelope = { task: "Correct the specified typo.", knownScope: ["README.md"] };

function response(text = JSON.stringify(label), overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function harness(impl: () => Promise<AssistantMessage> = async () => response()) {
	const calls: { model: Model<Api>; context: Context; options?: StreamOptions }[] = [];
	const registry: Parameters<typeof classifyTask>[0] = {
		complete: async (model, context, options) => {
			calls.push({ model, context, options });
			return impl();
		},
	};
	return { registry, calls };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test("uses one authenticated normal completion, no tools, no speculative effort, and a bounded response", async () => {
	const h = harness();
	const samples: ClassifierUsage[] = [];
	const result = await classifyTask(h.registry, model, envelope, { onUsage: (sample) => samples.push(sample) });
	expect(result).toMatchObject(label);
	expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	expect(result.fallback).toBeUndefined();
	expect(h.calls).toHaveLength(1);
	const call = h.calls[0];
	expect(call.model).toBe(model);
	expect(call.context.systemPrompt).toBe(CLASSIFIER_PROMPT);
	expect(call.context.tools).toBeUndefined();
	expect(call.context.messages).toHaveLength(1);
	expect(call.context.messages[0].role).toBe("user");
	expect(JSON.parse(call.context.messages[0].content as string)).toEqual({ envelope, truncated: false });
	expect(call.options).toMatchObject({ maxTokens: 1_024, maxRetries: 0, timeoutMs: 8_000 });
	expect(call.options).not.toHaveProperty("reasoningEffort");
	expect(call.options).not.toHaveProperty("reasoning");
	expect(call.options).not.toHaveProperty("apiKey");
	expect(samples).toEqual([{ provider: model.provider, model: model.id, responseModel: undefined, usage }]);
});

test("prompt includes scope/uncertainty rubric, few-shot cases, and instruction/data separation", () => {
	for (const required of ["luna:", "sol:", "astra:", "Few-shot", "untrusted", "insufficient_context", "exactly"])
		expect(CLASSIFIER_PROMPT).toContain(required);
});

test("valid JSON for all tiers round-trips (fixture plumbing, not live classifier accuracy)", async () => {
	expect(new Set(ROUTING_EVALUATION_CASES.map((item) => item.expected.tier))).toEqual(
		new Set(["luna", "sol", "astra"]),
	);
	expect(new Set(ROUTING_EVALUATION_CASES.map((item) => item.id)).size).toBe(ROUTING_EVALUATION_CASES.length);
	for (const item of ROUTING_EVALUATION_CASES) {
		const h = harness(async () => response(JSON.stringify(item.expected)));
		const result = await classifyTask(h.registry, model, item.envelope);
		expect(result).toMatchObject(item.expected);
		expect(result.fallback).toBeUndefined();
	}
});

test("strict parser rejects malformed JSON, wrong types, extra keys, prose, and unbounded reasons", () => {
	for (const text of [
		"",
		"not JSON",
		"null",
		"[]",
		`\`\`\`json\n${JSON.stringify(label)}\n\`\`\``,
		`${JSON.stringify(label)} explanation`,
		JSON.stringify({ ...label, tier: "small" }),
		JSON.stringify({ ...label, tier: ["luna"] }),
		JSON.stringify({ ...label, reason: " " }),
		JSON.stringify({ ...label, reason: 5 }),
		JSON.stringify({ ...label, reason: "x".repeat(401) }),
		JSON.stringify({ ...label, insufficient_context: "false" }),
		JSON.stringify({ tier: "luna", reason: "Missing field" }),
		JSON.stringify({ ...label, confidence: 1 }),
		" ".repeat(2_049) + JSON.stringify(label),
	])
		expect(parseClassification(text)).toBeUndefined();
	expect(parseClassification(JSON.stringify({ ...label, reason: "  trimmed  " }))).toEqual({
		...label,
		reason: "trimmed",
	});
});

test("malformed and incomplete responses fall back to Sol but still account exactly once", async () => {
	for (const reply of [
		response("invalid"),
		response(JSON.stringify(label), { stopReason: "error", errorMessage: "private provider detail" }),
		response(JSON.stringify(label), { stopReason: "length" }),
		response(JSON.stringify(label), { stopReason: "toolUse" }),
		response(JSON.stringify(label), { stopReason: "pending" }),
		response(JSON.stringify(label), { stopReason: "deferred" }),
		response(JSON.stringify(label), { content: [] }),
		response(JSON.stringify(label), {
			content: [
				{ type: "text", text: JSON.stringify(label) },
				{ type: "toolCall", id: "1", name: "bad", arguments: {} },
			],
		}),
	]) {
		const h = harness(async () => reply);
		const samples: ClassifierUsage[] = [];
		const result = await classifyTask(h.registry, model, envelope, { onUsage: (sample) => samples.push(sample) });
		expect(result).toMatchObject({ tier: "sol", insufficient_context: true });
		expect(result.fallback).toBeDefined();
		expect(result.reason).not.toContain("private provider detail");
		expect(samples).toHaveLength(1);
		expect(samples[0].usage).toBe(usage);
		expect(h.calls).toHaveLength(1);
	}
});

test("thrown completion errors use Sol without retry", async () => {
	const h = harness(() => {
		throw new Error("provider failure");
	});
	expect(await classifyTask(h.registry, model, envelope)).toMatchObject({ tier: "sol", fallback: "error" });
	expect(h.calls).toHaveLength(1);
});

test("bounded input accounts for JSON escaping and truncation cannot justify Luna", async () => {
	const h = harness();
	const input = {
		task: "x".repeat(20_000),
		context: "\u0000".repeat(20_000),
		knownScope: Array(20).fill("y".repeat(2_000)),
		uncertainties: Array(20).fill("z".repeat(2_000)),
		expectedOutput: "q".repeat(20_000),
	};
	const result = await classifyTask(h.registry, model, input);
	const content = h.calls[0].context.messages[0].content as string;
	const bounded = JSON.parse(content);
	expect(content.length).toBeLessThan(16_000);
	expect(bounded.truncated).toBe(true);
	expect(bounded.envelope.knownScope).toHaveLength(8);
	expect(bounded.envelope.uncertainties).toHaveLength(8);
	expect(result).toMatchObject({ tier: "sol", insufficient_context: true, fallback: "insufficient-context" });
	expect(input.task.length).toBe(20_000);
});

test("insufficient context cannot select Luna but explicit Astra complexity remains Astra", async () => {
	for (const tier of ["luna", "astra"] as const) {
		const h = harness(async () => response(JSON.stringify({ ...label, tier, insufficient_context: true })));
		expect(await classifyTask(h.registry, model, envelope)).toMatchObject({
			tier: tier === "luna" ? "sol" : "astra",
			insufficient_context: true,
		});
	}
});

test("caps options to model and classifier output budgets", async () => {
	for (const [request, modelLimit, expected] of [
		[10_000, 8_192, 4_096],
		[2_048, 4_096, 2_048],
		[500, 100, 100],
		[0, 4_096, 1_024],
		[NaN, 4_096, 1_024],
	]) {
		const h = harness();
		await classifyTask(h.registry, { ...model, maxTokens: modelLimit }, envelope, {
			maxTokens: request,
			timeoutMs: Infinity,
		});
		expect(h.calls[0].options?.maxTokens).toBe(expected);
		expect(h.calls[0].options?.timeoutMs).toBe(8_000);
	}
});

test("selects the lowest explicitly supported mapped effort without guessing provider capabilities", async () => {
	for (const [api, reasoning, thinkingLevelMap, expected] of [
		["openai-codex-responses", true, { off: null, minimal: null, low: "low", medium: "medium" }, "low"],
		["openai-codex-responses", true, { off: "none", low: "low" }, "none"],
		["openai-responses", true, { off: null, minimal: "low" }, "minimal"],
		["openai-responses", true, { off: "none", low: "low" }, undefined],
		["openai-responses", true, { off: null, minimal: null, low: null }, undefined],
		["openai-responses", false, { off: null, low: "low" }, undefined],
		["unknown-api", true, { off: null, low: "low" }, undefined],
	] as const) {
		const h = harness();
		await classifyTask(h.registry, { ...model, api, reasoning, thinkingLevelMap }, envelope);
		expect(h.calls[0].options).toMatchObject(expected ? { reasoningEffort: expected } : {});
		if (!expected) expect(h.calls[0].options).not.toHaveProperty("reasoningEffort");
	}
});

test("virtual and non-chat classifiers and empty tasks never dispatch", async () => {
	const h = harness();
	for (const invalid of [
		{ ...model, api: "pi-virtual" },
		{ ...model, type: "classifier" },
	])
		expect(await classifyTask(h.registry, invalid as Model<Api>, envelope)).toMatchObject({
			tier: "sol",
			fallback: "invalid-classifier",
		});
	expect(await classifyTask(h.registry, model, { task: " \n" })).toMatchObject({
		tier: "sol",
		fallback: "insufficient-context",
	});
	expect(h.calls).toHaveLength(0);
});

test("pre-aborted requests reject without dispatch", async () => {
	const h = harness();
	const controller = new AbortController();
	controller.abort("cancelled");
	await expect(classifyTask(h.registry, model, envelope, { signal: controller.signal })).rejects.toMatchObject({
		name: "AbortError",
	});
	expect(h.calls).toHaveLength(0);
});

test("caller abort promptly rejects even if completion ignores signal, with late usage recorded once", async () => {
	const d = deferred<AssistantMessage>();
	const h = harness(() => d.promise);
	const controller = new AbortController();
	const samples: ClassifierUsage[] = [];
	const result = classifyTask(h.registry, model, envelope, {
		signal: controller.signal,
		onUsage: (sample) => samples.push(sample),
	});
	controller.abort(new Error("cancelled by caller"));
	await expect(result).rejects.toMatchObject({ name: "AbortError" });
	expect(h.calls[0].options?.signal?.aborted).toBe(true);
	expect(samples).toHaveLength(0);
	d.resolve(response("malformed", { stopReason: "aborted" }));
	await d.promise;
	await Promise.resolve();
	expect(samples).toHaveLength(1);
});

test("provider aborted responses reject rather than returning a routable fallback and account usage", async () => {
	const h = harness(async () => response("", { stopReason: "aborted" }));
	const samples: ClassifierUsage[] = [];
	await expect(
		classifyTask(h.registry, model, envelope, { onUsage: (sample) => samples.push(sample) }),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(samples).toHaveLength(1);
});

test("provider AbortError rejection propagates", async () => {
	const error = new Error("provider cancellation");
	error.name = "AbortError";
	const h = harness(async () => {
		throw error;
	});
	await expect(classifyTask(h.registry, model, envelope)).rejects.toBe(error);
});

test("timeout aborts transport, returns Sol, and records a late response exactly once", async () => {
	const d = deferred<AssistantMessage>();
	const h = harness(() => d.promise);
	const samples: ClassifierUsage[] = [];
	const result = await classifyTask(h.registry, model, envelope, {
		timeoutMs: 1,
		onUsage: (sample) => samples.push(sample),
	});
	expect(result).toMatchObject({ tier: "sol", fallback: "timeout", insufficient_context: true });
	expect(h.calls[0].options?.signal?.aborted).toBe(true);
	expect(samples).toHaveLength(0);
	d.resolve(response("invalid", { stopReason: "error" }));
	await d.promise;
	await Promise.resolve();
	expect(samples).toHaveLength(1);
	expect(h.calls).toHaveLength(1);
});

test("late rejected completions after timeout are consumed", async () => {
	const d = deferred<AssistantMessage>();
	const h = harness(() => d.promise);
	expect(await classifyTask(h.registry, model, envelope, { timeoutMs: 1 })).toMatchObject({ fallback: "timeout" });
	d.reject(new Error("late failure"));
	await Promise.resolve();
	await Promise.resolve();
});

test("usage retains request target, reported response identity, and exact response pricing", async () => {
	for (const overrides of [{ responseModel: "actual-deployment" }, { model: "actual-deployment" }]) {
		const h = harness(async () => response(undefined, overrides));
		const samples: ClassifierUsage[] = [];
		await classifyTask(h.registry, model, envelope, { onUsage: (sample) => samples.push(sample) });
		expect(samples).toEqual([{ provider: model.provider, model: model.id, responseModel: "actual-deployment", usage }]);
		expect(samples[0].usage).toBe(usage);
	}
});

test("a broken usage observer cannot alter routing or cause a second sample", async () => {
	const h = harness();
	let observed = 0;
	expect(
		await classifyTask(h.registry, model, envelope, {
			onUsage: () => {
				observed++;
				throw new Error("observer");
			},
		}),
	).toMatchObject(label);
	expect(observed).toBe(1);
});

test("onSettled runs once after usage for successful, malformed, error, aborted, and rejected calls", async () => {
	for (const reply of [
		response(),
		response("invalid"),
		response("", { stopReason: "error" }),
		response("", { stopReason: "aborted" }),
		undefined,
	]) {
		const events: string[] = [];
		const h = harness(async () => {
			if (!reply) throw new Error("failed");
			return reply;
		});
		const result = classifyTask(h.registry, model, envelope, {
			onStarted: () => events.push("started"),
			onUsage: () => events.push("usage"),
			onSettled: () => events.push("settled"),
		});
		if (reply?.stopReason === "aborted") await expect(result).rejects.toMatchObject({ name: "AbortError" });
		else await result;
		expect(events).toEqual(reply ? ["started", "usage", "settled"] : ["started", "settled"]);
	}
});

test("onSettled waits for underlying transport after timeout, including a late rejection", async () => {
	for (const shouldReject of [false, true]) {
		const d = deferred<AssistantMessage>();
		const h = harness(() => d.promise);
		const events: string[] = [];
		await classifyTask(h.registry, model, envelope, {
			timeoutMs: 1,
			onUsage: () => events.push("usage"),
			onSettled: () => events.push("settled"),
		});
		expect(events).toEqual([]);
		if (shouldReject) d.reject(new Error("late error"));
		else d.resolve(response());
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(shouldReject ? ["settled"] : ["usage", "settled"]);
	}
});

test("no dispatch means no onSettled, and throwing onSettled observers do not alter routing", async () => {
	const h = harness();
	let settled = 0;
	let started = 0;
	const onStarted = () => {
		started++;
	};
	const onSettled = () => {
		settled++;
		throw new Error("observer");
	};
	await classifyTask(h.registry, model, { task: "" }, { onStarted, onSettled });
	expect(started).toBe(0);
	expect(settled).toBe(0);
	expect(await classifyTask(h.registry, model, envelope, { onStarted, onSettled })).toMatchObject(label);
	expect(started).toBe(1);
	expect(settled).toBe(1);
});

test("onStarted precedes dispatch and onSettled handles a synchronous registry error", async () => {
	const events: string[] = [];
	const registry: Parameters<typeof classifyTask>[0] = {
		complete: () => {
			events.push("dispatch");
			throw new Error("sync failure");
		},
	};
	expect(
		await classifyTask(registry, model, envelope, {
			onStarted: () => events.push("started"),
			onSettled: () => events.push("settled"),
		}),
	).toMatchObject({ fallback: "error" });
	expect(events).toEqual(["started", "dispatch", "settled"]);
});

test("upstream conversation clipping marks uncertainty before classifier budgets are applied", async () => {
	const plan = response(`A local change. ${"x".repeat(2100)} Preserve cross-service ordering under concurrency.`);
	const { envelope: clipped } = taskEnvelope([
		plan,
		{ role: "user", content: "Implement the plan above.", timestamp: 1 },
	]);
	expect(clipped.context).not.toContain("cross-service ordering");
	expect(clipped.truncated).toBe(true);
	const h = harness();
	const result = await classifyTask(h.registry, model, clipped);
	expect(JSON.parse(h.calls[0].context.messages[0].content as string).truncated).toBe(true);
	expect(result).toMatchObject({ tier: "sol", insufficient_context: true, fallback: "insufficient-context" });

	const fullContext = taskEnvelope([
		{ role: "user", content: "a".repeat(2000), timestamp: 1 },
		response("b".repeat(2000)),
		{ role: "user", content: "c".repeat(2000), timestamp: 2 },
		response("d".repeat(2000)),
		{ role: "user", content: "Proceed.", timestamp: 3 },
	]).envelope;
	expect(fullContext.context).toHaveLength(8000);
	expect(fullContext.truncated).toBe(true);
});
