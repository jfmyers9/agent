import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageHudConfig } from "./config";

export type ContextPressure = "normal" | "warning" | "error" | "unknown";

export type HudState = {
	cwd: string;
	providerLabel: string;
	modelLabel: string;
	thinkingLevel?: string;
	contextPercent: number | null;
	contextUsed: number | null;
	contextWindow: number | null;
	contextPressure: ContextPressure;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	hasUsage: boolean;
};

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: {
		total?: number;
	};
};

function formatProvider(provider: string | undefined): string {
	if (!provider) return "Unknown";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		google: "Google",
		gemini: "Google",
		"google-gemini-cli": "Google",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
		"github-copilot": "Copilot",
	};
	return (
		known[provider] ??
		provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
	);
}

function contextPressure(
	percent: number | null,
	config: UsageHudConfig,
): ContextPressure {
	if (percent === null) return "unknown";
	if (percent >= config.usageHud.contextErrorPercent) return "error";
	if (percent >= config.usageHud.contextWarningPercent) return "warning";
	return "normal";
}

function addUsageTotals(
	ctx: ExtensionContext,
): Pick<HudState, "inputTokens" | "outputTokens" | "cost" | "hasUsage"> {
	let inputTokens = 0;
	let outputTokens = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant")
			continue;
		const usage = entry.message.usage as UsageLike | undefined;
		if (!usage) continue;
		inputTokens += usage.input ?? 0;
		inputTokens += usage.cacheRead ?? 0;
		inputTokens += usage.cacheWrite ?? 0;
		outputTokens += usage.output ?? 0;
		cost += usage.cost?.total ?? 0;
	}

	return {
		inputTokens,
		outputTokens,
		cost,
		hasUsage: inputTokens > 0 || outputTokens > 0 || cost > 0,
	};
}

export function buildHudState(
	ctx: ExtensionContext,
	config: UsageHudConfig,
	thinkingLevel: string | undefined,
): HudState {
	const usage = ctx.getContextUsage();
	const contextWindow =
		usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
	const contextPercent = usage?.percent ?? null;
	const contextUsed =
		usage?.tokens ??
		(contextPercent !== null && contextWindow !== null
			? Math.round((contextPercent / 100) * contextWindow)
			: null);
	const modelLabel = ctx.model?.name ?? ctx.model?.id ?? "no-model";
	const providerLabel = formatProvider(ctx.model?.provider);

	return {
		cwd: ctx.cwd,
		providerLabel,
		modelLabel,
		thinkingLevel: ctx.model?.reasoning ? thinkingLevel : undefined,
		contextPercent,
		contextUsed,
		contextWindow,
		contextPressure: contextPressure(contextPercent, config),
		...addUsageTotals(ctx),
	};
}
