import { createHash } from "node:crypto";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	type ModelRoute,
	type ModelRouteRequest,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "@earendil-works/pi-coding-agent";
import { pendingAssessment } from "./affinity.js";
import { classifyTask, isActiveWorkBrief } from "./classifier.js";
import { manualPin } from "./pin.js";
import { isModelRef, modelName, ROUTING_MODEL, ROUTING_PROVIDER, type RoutingSettings } from "./settings.js";
import type { ActiveWorkBrief, ClassifierResult, ClassifierUsage, ModelRef, TaskEnvelope, Tier } from "./types.js";

export interface RoutingState {
	version: 1;
	taskKey: string;
	task: string;
	tier: Tier | "manual";
	model: ModelRef;
	reason: string;
	/** Last explicit reassessment consumed on this branch; absent in older sessions. */
	assessmentId?: string;
	activeWork?: ActiveWorkBrief;
	taskTruncated?: boolean;
}
export interface RoutingDecision {
	kind: "main" | "subagent";
	task: string;
	model: ModelRef;
	tier: RoutingState["tier"];
	reason: string;
	latencyMs: number;
	assessment: "complete" | "incomplete" | "failed";
	recommendedTier?: Tier;
	fallback?: string;
}

export const isAuto = (model: Model<any> | undefined) =>
	model?.provider === ROUTING_PROVIDER && model.id === ROUTING_MODEL;
export function isRoutingState(value: unknown): value is RoutingState {
	const state = value as RoutingState | undefined;
	return (
		state?.version === 1 &&
		typeof state.taskKey === "string" &&
		typeof state.task === "string" &&
		["luna", "sol", "astra", "manual"].includes(state.tier) &&
		isModelRef(state.model) &&
		typeof state.reason === "string" &&
		(state.assessmentId === undefined || typeof state.assessmentId === "string") &&
		(state.taskTruncated === undefined || typeof state.taskTruncated === "boolean") &&
		(state.activeWork === undefined || isActiveWorkBrief(state.activeWork))
	);
}

export function branchRoutingState(ctx: Pick<ExtensionContext, "sessionManager">): RoutingState | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as VirtualModelStateData | undefined;
		if (data?.provider === ROUTING_PROVIDER && data.modelId === ROUTING_MODEL && isRoutingState(data.state))
			return data.state;
	}
	return undefined;
}

export function physicalModel(ref: ModelRef, ctx: Pick<ExtensionContext, "modelRegistry">): Model<Api> {
	const model = ctx.modelRegistry.find(ref.provider, ref.id);
	if (!model || model.api === ("pi-virtual" as string))
		throw new Error(`Routing target is not an available physical model: ${modelName(ref)}. Use /routing setup.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model))
		throw new Error(
			`Routing target has no configured authentication: ${modelName(ref)}. Sign in or use /routing setup.`,
		);
	return model;
}

function text(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((part) =>
			part.type === "text"
				? [part.text]
				: part.type === "image"
					? ["[Image attached; its contents have not been classified.]"]
					: [],
		)
		.join("\n");
}

export function taskEnvelope(
	messages: readonly Message[],
	previous?: RoutingState,
	reset = false,
): { envelope: TaskEnvelope; key: string } {
	const latest = messages.findLastIndex((message) => message.role === "user");
	const current = latest >= 0 ? messages[latest]! : undefined;
	const fullTask = current ? text(current) : "";
	const task = fullTask.slice(0, 12_000);
	const history = reset
		? []
		: messages
				.slice(0, latest < 0 ? messages.length : latest)
				.filter((message) => message.role === "user" || message.role === "assistant");
	let historyOmitted = history.length > 4;
	const preceding = history
		.slice(-4)
		.map((message) => {
			const content = text(message);
			if (content.length > 2000) historyOmitted = true;
			return `${message.role}: ${content.slice(0, 2000)}`;
		})
		.filter((item) => !/^(user|assistant):\s*$/.test(item));
	const activeWork = reset ? undefined : previous?.activeWork;
	// Legacy sessions keep their model affinity, but raw old task fragments are only history.
	if (!reset && previous?.task && !activeWork) {
		preceding.unshift(`Legacy task context (may be incomplete): ${previous.task.slice(0, 2000)}`);
		if (previous.taskTruncated || previous.task.length > 2000) historyOmitted = true;
	}
	const fullHistory = preceding.join("\n\n");
	if (fullHistory.length > 8000) historyOmitted = true;
	const recentHistory = fullHistory.slice(-8000);
	return {
		envelope: {
			task,
			...(activeWork ? { activeWork } : {}),
			...(recentHistory ? { recentHistory } : {}),
			...(historyOmitted ? { historyOmitted: true } : {}),
			...(fullTask.length > 12_000 ? { truncated: true } : {}),
		},
		key: createHash("sha256")
			.update(JSON.stringify(current ?? { task, recentHistory }))
			.digest("hex"),
	};
}

const tierRank: Record<RoutingState["tier"], number> = { luna: 0, sol: 1, astra: 2, manual: Infinity };

function conservativeTier(result: ClassifierResult): Tier {
	if (result.fallback) return "sol";
	return result.insufficient_context && result.tier === "luna" ? "sol" : result.tier;
}

function assessmentDetails(
	result: ClassifierResult,
	tier: RoutingState["tier"],
	retained = false,
): Pick<RoutingDecision, "assessment" | "recommendedTier" | "reason" | "fallback"> {
	const assessment = result.fallback ? "failed" : result.insufficient_context ? "incomplete" : "complete";
	const recommendedTier = result.fallback ? undefined : (result.recommendedTier ?? result.tier);
	const origin = result.fallback
		? `Assessment failed (${result.fallback}); fallback floor Sol`
		: `Recommended ${recommendedTier}${result.insufficient_context ? " (incomplete task scope; floor Sol)" : ""}`;
	const action = retained ? `retaining ${tier} (upgrade-only)` : `using ${tier}`;
	return {
		assessment,
		recommendedTier,
		reason: `${origin}; ${action}. ${result.reason}`,
		...(result.fallback ? { fallback: result.fallback } : {}),
	};
}

type RouterOptions = {
	loadSettings: () => Promise<RoutingSettings | undefined>;
	classify?: typeof classifyTask;
	onUsage?: (ctx: ExtensionContext, sample: ClassifierUsage) => void;
	onMissingUsage?: (ctx: ExtensionContext, model: ModelRef) => void;
	onDecision?: (ctx: ExtensionContext, decision: RoutingDecision) => void;
};

export class TaskRouter {
	private readonly transports = new Map<string, Set<() => void>>();
	constructor(private readonly options: RouterOptions) {}
	hasPending(ctx: ExtensionContext): boolean {
		return (this.transports.get(ctx.sessionManager.getSessionId())?.size ?? 0) > 0;
	}
	/** Persist unresolved spend while the extension API still belongs to this session. */
	close(ctx: ExtensionContext): void {
		const session = ctx.sessionManager.getSessionId();
		for (const abandon of this.transports.get(session) ?? []) abandon();
		this.transports.delete(session);
	}
	private pinnedRoute(
		request: ModelRouteRequest<RoutingState>,
		ctx: ExtensionContext,
		state?: RoutingState,
	): ModelRoute<RoutingState> | undefined {
		const pin = manualPin(ctx);
		if (!pin) return;
		// A model-selection event can persist a newer baseline while classification awaits.
		return {
			model: physicalModel(pin, ctx),
			thinkingLevel: request.thinkingLevel,
			state: branchRoutingState(ctx) ?? state,
		};
	}
	private async settings(): Promise<RoutingSettings> {
		const settings = await this.options.loadSettings();
		if (!settings)
			throw new Error(
				"Auto routing is not configured. Use /routing setup, then /routing on (or select Auto — Luna routing in /model).",
			);
		return settings;
	}
	private async classify(
		settings: RoutingSettings,
		envelope: TaskEnvelope,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<ClassifierResult> {
		let classifier: Model<Api>;
		try {
			classifier = physicalModel(settings.classifier, ctx);
		} catch {
			return {
				tier: "sol",
				reason: "Configured Luna classifier is unavailable; using the conservative default.",
				insufficient_context: true,
				latencyMs: 0,
				fallback: "classifier-unavailable",
			};
		}
		const session = ctx.sessionManager.getSessionId();
		let settled = false;
		let started = false;
		let usage = false;
		let abandoned = false;
		const abandon = () => {
			if (abandoned) return;
			if (!usage) this.options.onMissingUsage?.(ctx, settings.classifier);
			abandoned = true;
		};
		const onSettled = () => {
			if (settled || !started) return;
			settled = true;
			const pending = this.transports.get(session);
			pending?.delete(abandon);
			if (pending?.size === 0) this.transports.delete(session);
			if (!usage && !abandoned) this.options.onMissingUsage?.(ctx, settings.classifier);
		};
		return await (this.options.classify ?? classifyTask)(ctx.modelRegistry, classifier, envelope, {
			signal,
			timeoutMs: settings.timeoutMs,
			maxTokens: settings.maxTokens,
			onStarted: () => {
				started = true;
				let pending = this.transports.get(session);
				if (!pending) {
					pending = new Set();
					this.transports.set(session, pending);
				}
				pending.add(abandon);
			},
			onUsage: (sample) => {
				if (abandoned) return; // Reload recorded unknown spend; never call the stale extension API.
				this.options.onUsage?.(ctx, sample);
				usage = true;
			},
			onSettled,
		});
	}

	async route(request: ModelRouteRequest<RoutingState>, ctx: ExtensionContext): Promise<ModelRoute<RoutingState>> {
		request.signal?.throwIfAborted();
		const state = isRoutingState(request.state) ? request.state : undefined;
		const pinned = this.pinnedRoute(request, ctx, state);
		if (pinned) return pinned;
		if (request.reason !== "user") {
			const sticky = request.failed ?? request.previous;
			if (sticky && sticky.model.api !== ("pi-virtual" as string))
				return {
					model: physicalModel(sticky.model, ctx),
					thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel,
					state,
				};
			if (state) return { model: physicalModel(state.model, ctx), thinkingLevel: request.thinkingLevel, state };
			// Compaction/direct calls must never invoke a second classifier. A fresh
			// child without inherited state is assigned Sol, not routed recursively.
			const settings = await this.settings();
			return (
				this.pinnedRoute(request, ctx, state) ?? {
					model: physicalModel(settings.tiers.sol, ctx),
					thinkingLevel: request.thinkingLevel,
				}
			);
		}
		const assessment = pendingAssessment(ctx, state);
		const { envelope, key } = taskEnvelope(request.messages, state, assessment?.mode === "reset");
		// Native model-route preflight can repeat for the same user message. Share
		// its saved decision, but reassess every distinct user turn while on Auto.
		if (state && !assessment && state.taskKey === key) {
			return { model: physicalModel(state.model, ctx), thinkingLevel: request.thinkingLevel, state };
		}
		if (state) physicalModel(state.model, ctx);
		const settings = await this.settings();
		const selected = this.pinnedRoute(request, ctx, state);
		if (selected) return selected;
		// Resolve the fallback up front. Never substitute another provider or
		// silently route to a weaker target when a configured model is unavailable.
		if (!state) physicalModel(settings.tiers.sol, ctx);
		const classification = await this.classify(settings, envelope, ctx, request.signal);
		request.signal?.throwIfAborted();
		const override = this.pinnedRoute(request, ctx, state);
		if (override) return override;
		const recommended = conservativeTier(classification);
		// Failure or missing scope has a Sol floor; it must never strand Auto on Luna.
		// Only a complete reset assessment may downgrade an already stronger baseline.
		const downgradeAllowed =
			assessment?.mode === "reset" && !classification.fallback && !classification.insufficient_context;
		const keepPrevious = state && !downgradeAllowed && tierRank[recommended] <= tierRank[state.tier];
		const tier = keepPrevious ? state.tier : recommended;
		const ref = keepPrevious ? state.model : settings.tiers[recommended];
		const model = physicalModel(ref, ctx);
		const details = assessmentDetails(classification, tier, !!keepPrevious);
		const updatedBrief = classification.fallback ? undefined : classification.active_work;
		const activeWork = updatedBrief ?? (assessment?.mode === "reset" ? undefined : state?.activeWork);
		const next: RoutingState = {
			version: 1,
			taskKey: key,
			task:
				activeWork?.objective ??
				(keepPrevious && assessment?.mode !== "reset" ? state.task : envelope.task.slice(0, 400)),
			...(activeWork ? { activeWork } : {}),
			tier,
			model: { provider: model.provider, id: model.id },
			reason: details.reason,
			...((assessment?.id ?? state?.assessmentId) ? { assessmentId: assessment?.id ?? state?.assessmentId } : {}),
		};
		this.options.onDecision?.(ctx, {
			kind: "main",
			task: envelope.task,
			model: next.model,
			tier,
			latencyMs: classification.latencyMs,
			...details,
		});
		return { model, thinkingLevel: request.thinkingLevel, state: next };
	}

	async subtask(
		envelope: TaskEnvelope,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<{ model: ModelRef; reason: string }> {
		signal?.throwIfAborted();
		const settings = await this.settings();
		physicalModel(settings.tiers.sol, ctx);
		const classification = await this.classify(settings, envelope, ctx, signal);
		signal?.throwIfAborted();
		const tier = conservativeTier(classification);
		const model = physicalModel(settings.tiers[tier], ctx);
		const ref = { provider: model.provider, id: model.id };
		this.options.onDecision?.(ctx, {
			kind: "subagent",
			task: envelope.task,
			model: ref,
			tier,
			...assessmentDetails(classification, tier),
			latencyMs: classification.latencyMs,
		});
		return { model: ref, reason: classification.reason };
	}
}
