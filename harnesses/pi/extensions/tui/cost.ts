import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { classifierUsageRecord, priceUsage } from "../routing/accounting";
import { type AgentCostSnapshot, getSubagentCosts } from "../subagents/runtime";

export { priceUsage } from "../routing/accounting";

type Registry = Pick<ExtensionContext["modelRegistry"], "find">;
export type CostTotals = {
	input: number;
	output: number;
	self: number;
	agents: number;
	total: number;
	recorded: number;
	missing: number;
	children: { id: string; cost: number; status: string }[];
};

const nonnegative = (value: number | undefined) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function sumSessionCosts(entries: readonly SessionEntry[], registry: Registry): CostTotals {
	const totals: CostTotals = {
		input: 0,
		output: 0,
		self: 0,
		agents: 0,
		total: 0,
		recorded: 0,
		missing: 0,
		children: [],
	};
	const classifierIds = new Set<string>();
	for (const entry of entries) {
		let usage: Usage | undefined;
		let provider: string | undefined;
		let model: string | undefined;
		let responseModel: string | undefined;
		const classifier = classifierUsageRecord(entry);
		if (classifier) {
			if (classifierIds.has(classifier.id)) continue;
			classifierIds.add(classifier.id);
			if (!classifier.usage) {
				totals.missing++;
				continue;
			}
			({ usage, provider, model, responseModel } = classifier);
		} else if (entry.type === "usage") {
			({ usage, provider, model } = entry);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		} else if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				({ usage, provider, model, responseModel } = entry.message);
			} else if (entry.message.role === "toolResult") usage = entry.message.usage;
		}
		if (!usage) continue;
		// Routing records freeze known prices when written; an unknown price must
		// remain a lower bound rather than becoming zero after JSON round-tripping.
		const priced = priceUsage(usage, classifier ? { find: () => undefined } : registry, provider, model, responseModel);
		totals.input += nonnegative(usage.input);
		totals.output += nonnegative(usage.output);
		totals.self += priced.cost;
		totals.recorded += Number(priced.recorded);
		totals.missing += Number(priced.missing);
	}
	totals.total = totals.self;
	return totals;
}

export function combineAgentCosts(
	totals: CostTotals,
	entries: readonly SessionEntry[],
	path: string,
	live: readonly AgentCostSnapshot[],
): CostTotals {
	const agents = new Map<string, AgentCostSnapshot>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "subagents:agent-v1") continue;
		const data = entry.data as { version?: number; agent?: AgentCostSnapshot } | undefined;
		const agent = data?.agent;
		if (data?.version === 1 && agent && typeof agent.id === "string" && typeof agent.cost === "number") {
			agents.set(agent.id, agent);
		}
	}
	for (const agent of live) agents.set(agent.id, agent);
	const own = agents.get(path);
	// Child transcripts include copied parent messages. The coordinator's ledger
	// only charges work performed by that child, including subsequent followups.
	const self = path !== "/root" && own ? nonnegative(own.cost) : totals.self;
	const missing = path !== "/root" && own?.costMissing !== undefined ? nonnegative(own.costMissing) : totals.missing;
	const children = [...agents.values()]
		.filter((agent) => agent.id.startsWith(`${path}/`))
		.map((agent) => ({ id: agent.id, cost: nonnegative(agent.cost), status: agent.status }))
		.sort((a, b) => a.id.localeCompare(b.id));
	const childCost = children.reduce((sum, agent) => sum + agent.cost, 0);
	const childMissing = [...agents.values()]
		.filter((agent) => agent.id.startsWith(`${path}/`))
		.reduce((sum, agent) => sum + nonnegative(agent.costMissing), 0);
	return { ...totals, self, missing: missing + childMissing, children, agents: childCost, total: self + childCost };
}

export function getSessionCosts(ctx: ExtensionContext): CostTotals {
	const entries = ctx.sessionManager.getEntries();
	const { path, agents } = getSubagentCosts(ctx.sessionManager.getSessionId());
	return combineAgentCosts(sumSessionCosts(entries, ctx.modelRegistry), entries, path, agents);
}

export function formatCost(cost: number): string {
	return cost > 0 && cost < 0.0001 ? "<$0.0001" : `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
}

export function costLabel(totals: CostTotals): string {
	return `${totals.missing ? "≥" : ""}${formatCost(totals.total)}`;
}

export function costReport(totals: CostTotals): string {
	return [
		`Session cost (list-price estimate): ${costLabel(totals)}`,
		`This agent: ${formatCost(totals.self)}`,
		`Subagents (including nested): ${formatCost(totals.agents)}`,
		...totals.children.map((agent) => `  ${agent.id}: ${formatCost(agent.cost)} (${agent.status})`),
		"Includes all branches and recorded tool/summary usage. Inherited child history is not charged twice.",
		"Recorded request-time model prices include cache, long-context and service-tier rates; not subscription billing.",
		"Missing costs use the current model catalog where available. Unreported usage cannot be recovered.",
		...(totals.recorded
			? [`${totals.recorded} usage records use their stored cost (no model pricing attribution).`]
			: []),
		...(totals.missing ? [`${totals.missing} usage records lack a usable price; total is a lower bound.`] : []),
	].join("\n");
}
