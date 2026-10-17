import { expect, test } from "bun:test";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { combineAgentCosts, costLabel, sumSessionCosts } from "../tui/cost";
import {
	CLASSIFIER_USAGE_ENTRY_TYPE,
	classifierUsageRecord,
	recordClassifierUsage,
	recordClassifierUsageMissing,
} from "./accounting";

const model: Model<Api> = {
	id: "classifier",
	name: "Classifier",
	provider: "example",
	api: "openai-responses",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const registry = {
	find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
};
const ctx = { modelRegistry: registry as ExtensionContext["modelRegistry"] };
const usage = (total = 0.25): Usage => ({
	input: 1_000_000,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1_000_000,
	cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
function harness() {
	const manager = SessionManager.inMemory();
	const pi = {
		appendEntry: (type: string, data?: unknown) => {
			manager.appendCustomEntry(type, data);
		},
	};
	const record = (total = 0.25) =>
		recordClassifierUsage(pi, ctx, {
			provider: "example",
			model: "classifier",
			usage: usage(total),
		});
	return { manager, pi, record };
}

test("classifier spend is durable, outside model context, and summed once on every snapshot across branches", () => {
	const h = harness();
	const root = h.manager.appendMessage({ role: "user", content: "task", timestamp: 1 });
	const first = h.record();
	h.manager.branch(root);
	const second = h.record(0.75);
	expect(first.id).not.toBe(second.id);
	// Copied/replayed records retain their identity, not a second charge.
	h.manager.appendCustomEntry(CLASSIFIER_USAGE_ENTRY_TYPE, first);
	for (let i = 0; i < 3; i++) {
		const totals = sumSessionCosts(h.manager.getEntries(), registry);
		expect(totals.self).toBe(1);
		expect(totals.input).toBe(2_000_000);
	}
	expect(h.manager.buildSessionContext().messages).toHaveLength(1);
	expect(classifierUsageRecord(h.manager.getEntries()[1])).toEqual(first);
});

test("stored service-tier costs and legitimate zeros are never repriced or mutated", () => {
	const h = harness();
	const sample = { provider: "example", model: "classifier", responseModel: "dated", usage: usage(0.5) };
	const saved = recordClassifierUsage(h.pi, ctx, sample);
	expect(saved.responseModel).toBe("dated");
	expect(saved.usage).not.toBe(sample.usage);
	expect(saved.usage.cost).not.toBe(sample.usage.cost);
	sample.usage.cost.total = 100;
	h.record(0);
	expect(sumSessionCosts(h.manager.getEntries(), { find: () => undefined }).total).toBe(0.5);
});

test("missing provider price is frozen using response-model pricing before catalog changes", () => {
	const h = harness();
	const value = usage(Number.NaN);
	const saved = recordClassifierUsage(h.pi, ctx, {
		provider: "example",
		model: "request-alias",
		responseModel: "classifier",
		usage: value,
	});
	expect(saved.usage.cost.total).toBe(2);
	expect(value.cost.total).toBeNaN();
	expect(sumSessionCosts(h.manager.getEntries(), { find: () => undefined }).total).toBe(2);
});

test("unpriced classifier usage remains a lower bound after persistence; it is not free", () => {
	const h = harness();
	recordClassifierUsage(h.pi, ctx, { provider: "unknown", model: "unknown", usage: usage(Number.NaN) });
	const entries = JSON.parse(JSON.stringify(h.manager.getEntries()));
	const totals = sumSessionCosts(entries, registry);
	expect(totals.total).toBe(0);
	expect(totals.missing).toBe(1);
	expect(costLabel(totals)).toBe("≥$0.00");
});

test("root combines classifier and child costs; child own ledger excludes inherited routing records", () => {
	const h = harness();
	h.record(100);
	recordClassifierUsage(h.pi, ctx, { provider: "unknown", model: "unknown", usage: usage(Number.NaN) });
	const totals = sumSessionCosts(h.manager.getEntries(), registry);
	const agents = [
		{ id: "/root/worker", status: "running", cost: 2, costMissing: 0 },
		{ id: "/root/worker/nested", status: "idle", cost: 0.5, costMissing: 1 },
	];
	expect(combineAgentCosts(totals, [], "/root", agents)).toMatchObject({ total: 102.5, missing: 2 });
	const child = combineAgentCosts(totals, [], "/root/worker", agents);
	expect(child).toMatchObject({ self: 2, total: 2.5, missing: 1 });
	// Legacy snapshots lack a missing-price ledger; keep the conservative flag.
	const legacy = combineAgentCosts(totals, [], "/root/worker", [{ id: "/root/worker", status: "idle", cost: 2 }]);
	expect(legacy.missing).toBe(1);
});

test("unknown versions and malformed custom entries are ignored", () => {
	const h = harness();
	for (const data of [undefined, { version: 2 }, { version: 1, id: "", provider: "example", model: "classifier" }]) {
		h.manager.appendCustomEntry(CLASSIFIER_USAGE_ENTRY_TYPE, data);
	}
	expect(sumSessionCosts(h.manager.getEntries(), registry).total).toBe(0);
});

test("settled requests without usage mark a durable lower bound without fabricating token counts", () => {
	const h = harness();
	const record = recordClassifierUsageMissing(h.pi, { provider: "example", model: "classifier" });
	expect(record).not.toHaveProperty("usage");
	h.manager.appendCustomEntry(CLASSIFIER_USAGE_ENTRY_TYPE, record);
	const totals = sumSessionCosts(JSON.parse(JSON.stringify(h.manager.getEntries())), registry);
	expect(totals).toMatchObject({ total: 0, missing: 1, input: 0, output: 0 });
	expect(costLabel(totals)).toBe("≥$0.00");
});
