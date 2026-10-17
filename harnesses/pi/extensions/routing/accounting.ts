import { randomUUID } from "node:crypto";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type Registry = Pick<ExtensionContext["modelRegistry"], "find">;

export const CLASSIFIER_USAGE_ENTRY_TYPE = "routing:usage-v1";
export type ClassifierUsageSample = {
	provider: string;
	model: string;
	responseModel?: string;
	usage: Usage;
};
// Omitted usage means spend is unknown, including a transport abandoned at shutdown, not free.
export type ClassifierUsageRecord = Omit<ClassifierUsageSample, "usage"> & { version: 1; id: string; usage?: Usage };

export function classifierUsageRecord(entry: SessionEntry): ClassifierUsageRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== CLASSIFIER_USAGE_ENTRY_TYPE) return undefined;
	const data = entry.data as Partial<ClassifierUsageRecord> | undefined;
	if (
		data?.version !== 1 ||
		typeof data.id !== "string" ||
		!data.id ||
		typeof data.provider !== "string" ||
		typeof data.model !== "string" ||
		(data.responseModel !== undefined && typeof data.responseModel !== "string") ||
		(data.usage !== undefined && (!data.usage || typeof data.usage !== "object"))
	)
		return undefined;
	return data as ClassifierUsageRecord;
}

/**
 * Extensions cannot call SessionManager.appendUsage through the readonly context.
 * These versioned entries are consumed by /cost and the patched child cost ledger.
 * Call once per charged completion, even if its routing decision is discarded.
 */
export function recordClassifierUsage(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	sample: ClassifierUsageSample,
): ClassifierUsageRecord & { usage: Usage } {
	const usage = { ...sample.usage, cost: { ...sample.usage.cost } };
	const priced = priceUsage(usage, ctx.modelRegistry, sample.provider, sample.model, sample.responseModel);
	// Freeze a known price now, not against whatever catalog exists after resume.
	if (!priced.missing) usage.cost.total = priced.cost;
	const data: ClassifierUsageRecord & { usage: Usage } = {
		version: 1,
		id: randomUUID(),
		provider: sample.provider,
		model: sample.model,
		...(sample.responseModel ? { responseModel: sample.responseModel } : {}),
		usage,
	};
	pi.appendEntry(CLASSIFIER_USAGE_ENTRY_TYPE, data);
	return data;
}

/** Record unknown spend on settlement without telemetry, or before abandoning a transport at shutdown. */
export function recordClassifierUsageMissing(
	pi: Pick<ExtensionAPI, "appendEntry">,
	sample: Omit<ClassifierUsageSample, "usage">,
): ClassifierUsageRecord {
	const data: ClassifierUsageRecord = {
		version: 1,
		id: randomUUID(),
		provider: sample.provider,
		model: sample.model,
		...(sample.responseModel ? { responseModel: sample.responseModel } : {}),
	};
	pi.appendEntry(CLASSIFIER_USAGE_ENTRY_TYPE, data);
	return data;
}

// Unattributed tool/summary usage can combine several models. Its recorded
// dollar amount must not be repriced using the currently selected model.
export function priceUsage(
	usage: Usage,
	registry: Registry,
	provider?: string,
	modelId?: string,
	responseModel?: string,
) {
	// Recorded costs preserve request-time catalog prices and service-tier
	// adjustments. Repricing them would silently rewrite historical spend.
	const recordedCost = usage.cost?.total;
	if (typeof recordedCost === "number" && Number.isFinite(recordedCost) && recordedCost >= 0) {
		return { cost: recordedCost, recorded: !provider || !modelId, missing: false };
	}
	const requested = provider && modelId ? registry.find(provider, modelId) : undefined;
	const compat = requested?.compat;
	const fallback = (compat && "allowedFallbackModels" in compat ? compat.allowedFallbackModels : undefined)?.find(
		(model) => model.provider === provider && model.model === responseModel,
	);
	const model =
		(provider && responseModel ? registry.find(provider, responseModel) : undefined) ??
		(fallback && requested ? { ...requested, cost: fallback.cost } : requested);
	if (model) {
		const cost = calculateCost(model, { ...usage, cost: { ...usage.cost } }).total;
		if (Number.isFinite(cost) && cost >= 0) return { cost, recorded: false, missing: false };
	}
	return { cost: 0, recorded: true, missing: true };
}
