import { createHash } from "node:crypto";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { pendingAssessment } from "./affinity.js";
import { classifyTask } from "./classifier.js";
import { manualPin } from "./pin.js";
import { isModelRef, modelName, ROUTING_MODEL, ROUTING_PROVIDER, type RoutingSettings } from "./settings.js";
import type { ClassifierResult, ClassifierUsage, ModelRef, TaskEnvelope, Tier } from "./types.js";

export interface RoutingState {
	version: 1;
	taskKey: string;
	task: string;
	tier: Tier;
	model: ModelRef;
	reason: string;
	/** Last explicit reassessment consumed on this branch; absent in older sessions. */
	assessmentId?: string;
}
export interface RoutingDecision {
	kind: "main" | "subagent";
	task: string;
	model: ModelRef;
	tier: Tier;
	reason: string;
	latencyMs: number;
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
		["luna", "sol", "astra"].includes(state.tier) &&
		isModelRef(state.model) &&
		typeof state.reason === "string" &&
		(state.assessmentId === undefined || typeof state.assessmentId === "string")
	);
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
): { envelope: TaskEnvelope; key: string } {
	const latest = messages.findLastIndex((message) => message.role === "user");
	const current = latest >= 0 ? messages[latest]! : undefined;
	const task = current ? text(current).slice(0, 12_000) : "";
	const preceding = messages
		.slice(0, latest < 0 ? messages.length : latest)
		.filter((message) => message.role === "user" || message.role === "assistant")
		.slice(-4)
		.map((message) => `${message.role}: ${text(message).slice(0, 2000)}`)
		.filter((item) => !/^(user|assistant):\s*$/.test(item));
	if (previous)
		preceding.unshift(`Previous task: ${previous.task}\nPrevious route: ${previous.tier}; ${previous.reason}`);
	const context = preceding.join("\n\n").slice(-8000);
	return {
		envelope: { task, ...(context ? { context } : {}) },
		key: createHash("sha256")
			.update(JSON.stringify(current ?? { task, context }))
			.digest("hex"),
	};
}

const tierRank: Record<Tier, number> = { luna: 0, sol: 1, astra: 2 };

type RouterOptions = {
	loadSettings: () => Promise<RoutingSettings | undefined>;
	classify?: typeof classifyTask;
	onUsage?: (ctx: ExtensionContext, sample: ClassifierUsage) => void;
	onMissingUsage?: (ctx: ExtensionContext, model: ModelRef) => void;
	onDecision?: (ctx: ExtensionContext, decision: RoutingDecision) => void;
};

export class TaskRouter {
	private readonly transports = new Map<string, number>();
	constructor(private readonly options: RouterOptions) {}
	hasPending(ctx: ExtensionContext): boolean {
		return (this.transports.get(ctx.sessionManager.getSessionId()) ?? 0) > 0;
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
		const onSettled = () => {
			if (settled || !started) return;
			settled = true;
			const count = (this.transports.get(session) ?? 1) - 1;
			if (count > 0) this.transports.set(session, count);
			else this.transports.delete(session);
			if (!usage) this.options.onMissingUsage?.(ctx, settings.classifier);
		};
		return await (this.options.classify ?? classifyTask)(ctx.modelRegistry, classifier, envelope, {
			signal,
			timeoutMs: settings.timeoutMs,
			maxTokens: settings.maxTokens,
			onStarted: () => {
				started = true;
				this.transports.set(session, (this.transports.get(session) ?? 0) + 1);
			},
			onUsage: (sample) => {
				this.options.onUsage?.(ctx, sample);
				usage = true;
			},
			onSettled,
		});
	}

	async route(request: ModelRouteRequest<RoutingState>, ctx: ExtensionContext): Promise<ModelRoute<RoutingState>> {
		request.signal?.throwIfAborted();
		const state = isRoutingState(request.state) ? request.state : undefined;
		const pin = manualPin(ctx);
		if (pin) {
			return { model: physicalModel(pin, ctx), thinkingLevel: request.thinkingLevel, state };
		}
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
			return { model: physicalModel(settings.tiers.sol, ctx), thinkingLevel: request.thinkingLevel };
		}
		const assessment = pendingAssessment(ctx, state);
		const { envelope, key } = taskEnvelope(request.messages, state);
		// Native model-route preflight can repeat for the same user message. Share
		// its saved decision, but reassess every distinct user turn while on Auto.
		if (state && !assessment && state.taskKey === key) {
			return { model: physicalModel(state.model, ctx), thinkingLevel: request.thinkingLevel, state };
		}
		if (state) physicalModel(state.model, ctx);
		const settings = await this.settings();
		// Resolve the fallback up front. Never substitute another provider or
		// silently route to a weaker target when a configured model is unavailable.
		if (!state) physicalModel(settings.tiers.sol, ctx);
		const classification = await this.classify(settings, envelope, ctx, request.signal);
		request.signal?.throwIfAborted();
		const recommended =
			classification.insufficient_context && classification.tier === "luna" ? "sol" : classification.tier;
		const unreliable = !!classification.fallback || (classification.insufficient_context && recommended !== "astra");
		const keepPrevious =
			state && (unreliable || (assessment?.mode !== "reset" && tierRank[recommended] <= tierRank[state.tier]));
		const tier = keepPrevious ? state.tier : recommended;
		const ref = keepPrevious ? state.model : settings.tiers[tier];
		const model = physicalModel(ref, ctx);
		const reason = keepPrevious
			? `${unreliable ? "Unreliable assessment" : "No tier upgrade"}; retaining session model. ${classification.reason}`
			: classification.reason;
		const activeTask = state ? `${state.task}\nFollow-up: ${envelope.task}`.slice(-2000) : envelope.task.slice(0, 2000);
		const next: RoutingState = {
			version: 1,
			taskKey: key,
			task: activeTask,
			tier,
			model: { provider: model.provider, id: model.id },
			reason,
			...((assessment?.id ?? state?.assessmentId) ? { assessmentId: assessment?.id ?? state?.assessmentId } : {}),
		};
		this.options.onDecision?.(ctx, {
			kind: "main",
			task: envelope.task,
			model: next.model,
			tier,
			reason,
			latencyMs: classification.latencyMs,
			...(classification.fallback ? { fallback: classification.fallback } : {}),
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
		const tier = classification.insufficient_context && classification.tier === "luna" ? "sol" : classification.tier;
		const model = physicalModel(settings.tiers[tier], ctx);
		const ref = { provider: model.provider, id: model.id };
		this.options.onDecision?.(ctx, {
			kind: "subagent",
			task: envelope.task,
			model: ref,
			tier,
			reason: classification.reason,
			latencyMs: classification.latencyMs,
			...(classification.fallback ? { fallback: classification.fallback } : {}),
		});
		return { model: ref, reason: classification.reason };
	}
}
