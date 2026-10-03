import { afterEach, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { installCoordinatorLookup } from "../subagents/runtime";
import {
	combineAgentCosts,
	costLabel,
	costReport,
	formatCost,
	getSessionCosts,
	priceUsage,
	sumSessionCosts,
} from "./cost";

const model: Model<Api> = {
	id: "model",
	name: "Model",
	provider: "example",
	api: "openai-responses",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000000,
	maxTokens: 10000,
	cost: {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
		tiers: [{ inputTokensAbove: 200000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
	},
};
const registry = {
	find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
};
const usage = (cost: number): Usage => ({
	input: 100,
	output: 50,
	cacheRead: 10,
	cacheWrite: 0,
	totalTokens: 160,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const message = (cost: number): AssistantMessage => ({
	role: "assistant",
	content: [],
	provider: model.provider,
	model: model.id,
	api: model.api,
	usage: usage(cost),
	stopReason: "stop",
	timestamp: 1,
});
afterEach(() => installCoordinatorLookup(() => undefined));

test("recorded request-time prices, service-tier adjustments and legitimate zeros are preserved", () => {
	for (const cost of [0, 0.5, 2.5]) {
		const value = usage(cost);
		expect(priceUsage(value, registry, model.provider, model.id).cost).toBe(cost);
		expect(value.cost.total).toBe(cost);
	}
});

test("missing historical price falls back to model pricing with cache and long-context tiers", () => {
	const value = { ...usage(Number.NaN), input: 100000, cacheRead: 100000, output: 1000 };
	expect(priceUsage(value, registry, model.provider, model.id).cost).toBeCloseTo(0.23);
	value.input++;
	expect(priceUsage(value, registry, model.provider, model.id).cost).toBeCloseTo(0.455004);
	expect(Number.isNaN(value.cost.total)).toBe(true);
});

test("cache writes use the one-hour rate and reasoning is not charged twice", () => {
	const value = {
		...usage(Number.NaN),
		input: 0,
		cacheRead: 0,
		output: 100,
		reasoning: 60,
		cacheWrite: 1000,
		cacheWrite1h: 500,
	};
	expect(priceUsage(value, registry, model.provider, model.id).cost).toBeCloseTo(0.00425);
});

test("fallback uses actual known response model, never selected model for unattributed costs", () => {
	const value = usage(Number.NaN);
	expect(priceUsage(value, registry, model.provider, "unknown", model.id).cost).toBeGreaterThan(0);
	expect(priceUsage(value, registry).missing).toBe(true);
	expect(priceUsage(usage(7), registry).cost).toBe(7);
});

test("cost survives compaction, branch navigation, errors and model switches", () => {
	const session = SessionManager.inMemory();
	const root = session.appendMessage({ role: "user", content: "test", timestamp: 1 });
	session.appendMessage(message(1));
	const kept = session.appendMessage({ ...message(2), stopReason: "error" });
	session.appendCompaction("summary", kept, 100, undefined, false, usage(0.3));
	expect(sumSessionCosts(session.getEntries(), registry).total).toBeCloseTo(3.3);
	session.branch(root);
	session.appendMessage({ ...message(0.25), provider: "other", model: "other" });
	session.appendUsage("background", "other", "other", usage(0.5));
	session.appendMessage({
		role: "toolResult",
		toolCallId: "t",
		toolName: "test",
		content: [],
		isError: false,
		timestamp: 1,
		usage: usage(0.1),
	});
	session.branchWithSummary(root, "branch summary", undefined, false, usage(0.2));
	expect(sumSessionCosts(session.getEntries(), registry).total).toBeCloseTo(4.35);
});

test("latest persisted child ledger is replaced by live values, nested agents counted once", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(message(1));
	for (const cost of [2, 3])
		session.appendCustomEntry("subagents:agent-v1", { version: 1, agent: { id: "/root/a", status: "idle", cost } });
	session.appendCustomEntry("subagents:agent-v1", {
		version: 1,
		agent: { id: "/root/a/nested", status: "failed", cost: 0.5 },
	});
	const totals = sumSessionCosts(session.getEntries(), registry);
	expect(combineAgentCosts(totals, session.getEntries(), "/root", []).total).toBe(4.5);
	const updated = combineAgentCosts(totals, session.getEntries(), "/root", [
		{ id: "/root/a", status: "running", cost: 4 },
	]);
	expect(updated.total).toBe(5.5);
	expect(updated.children).toHaveLength(2);
	expect(costReport(updated)).toContain("Subagents (including nested): $4.50");
});

test("child status excludes inherited parent history and sibling spend", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(message(100));
	installCoordinatorLookup(() => ({
		pathForSession: () => "/root/a",
		snapshot: () => [
			{ id: "/root/a", status: "idle", cost: 2 },
			{ id: "/root/a/nested", status: "idle", cost: 0.5 },
			{ id: "/root/ab", status: "idle", cost: 10 },
		],
	}));
	const totals = getSessionCosts({ sessionManager: session, modelRegistry: registry } as ExtensionContext);
	expect(totals.self).toBe(2);
	expect(totals.total).toBe(2.5);
});

test("unknown costs are explicit and tiny positive costs do not look like zero", () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ ...message(Number.NaN), model: "unknown" });
	const totals = sumSessionCosts(session.getEntries(), registry);
	expect(costLabel(totals)).toBe("≥$0.00");
	expect(costReport(totals)).toContain("lower bound");
	expect(formatCost(0.000001)).toBe("<$0.0001");
	expect(formatCost(0.0023)).toBe("$0.0023");
	expect(formatCost(1.23)).toBe("$1.23");
});
