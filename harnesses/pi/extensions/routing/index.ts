import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "@earendil-works/pi-coding-agent";
import { recordClassifierUsage, recordClassifierUsageMissing } from "./accounting.js";
import {
	isAuto,
	isRoutingState,
	physicalModel,
	type RoutingDecision,
	type RoutingState,
	TaskRouter,
} from "./router.js";
import {
	modelName,
	ROUTING_MODEL,
	ROUTING_PROVIDER,
	type RoutingSettings,
	RoutingSettingsStore,
	TIERS,
} from "./settings.js";
import { registerSubagentRouting } from "./subagents.js";
import type { ModelRef, Tier } from "./types.js";

const DECISION_ENTRY = "routing:decision-v1";
const clean = (value: string) => value.replace(/\p{Cc}/gu, " ").slice(0, 600);

export function branchRoutingState(ctx: ExtensionContext): RoutingState | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as VirtualModelStateData | undefined;
		if (data?.provider === ROUTING_PROVIDER && data.modelId === ROUTING_MODEL && isRoutingState(data.state))
			return data.state;
	}
	return undefined;
}

function availableModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.modelRegistry.getAvailable().filter((model) => model.api !== "pi-virtual" && model.input.includes("text"));
}

async function chooseModel(
	ctx: ExtensionContext,
	title: string,
	models: Model<Api>[],
	previous?: ModelRef,
	hint?: Tier,
): Promise<ModelRef | undefined> {
	const score = (model: Model<Api>) =>
		modelName(model) === (previous && modelName(previous)) ? 0 : hint && model.id.toLowerCase().includes(hint) ? 1 : 2;
	const names = [...models]
		.sort((a, b) => score(a) - score(b) || modelName(a).localeCompare(modelName(b)))
		.map(modelName);
	const chosen = await ctx.ui.select(title, names);
	const model = models.find((candidate) => modelName(candidate) === chosen);
	return model ? { provider: model.provider, id: model.id } : undefined;
}

export function registerRouting(
	pi: ExtensionAPI,
	store: Pick<RoutingSettingsStore, "load" | "save"> = new RoutingSettingsStore(),
): void {
	let preferences: RoutingSettings | undefined;
	async function loadSettings(): Promise<RoutingSettings | undefined> {
		preferences = await store.load();
		return preferences;
	}
	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		const state = branchRoutingState(ctx);
		ctx.ui.setStatus(
			"routing",
			isAuto(model)
				? `Auto: ${state?.tier ?? (preferences ? "ready" : "setup required")}`
				: preferences?.subagents
					? "Child Auto"
					: undefined,
		);
	}
	function onDecision(ctx: ExtensionContext, decision: RoutingDecision): void {
		const reason = clean(decision.reason);
		pi.appendEntry(DECISION_ENTRY, {
			version: 1,
			kind: decision.kind,
			model: decision.model,
			tier: decision.tier,
			reason,
			taskKey: createHash("sha256").update(decision.task).digest("hex"),
			latencyMs: Math.round(decision.latencyMs),
			...(decision.fallback ? { fallback: decision.fallback } : {}),
		});
		if (decision.kind === "main" && isAuto(ctx.model)) ctx.ui.setStatus("routing", `Auto: ${decision.tier}`);
		ctx.ui.notify(
			`Auto${decision.kind === "subagent" ? " child" : ""} → ${modelName(decision.model)} (${decision.tier}, ${Math.round(decision.latencyMs)}ms${decision.fallback ? `, ${decision.fallback}` : ""}): ${reason}`,
			decision.fallback ? "warning" : "info",
		);
	}
	const router = new TaskRouter({
		loadSettings,
		onDecision,
		onUsage: (ctx, sample) => {
			recordClassifierUsage(pi, ctx, sample);
		},
		onMissingUsage: (_ctx, model) => {
			recordClassifierUsageMissing(pi, { provider: model.provider, model: model.id });
		},
	});
	pi.registerVirtualModel<RoutingState>({
		provider: ROUTING_PROVIDER,
		id: ROUTING_MODEL,
		name: "Auto — Luna routing",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		route: (request, ctx) => router.route(request, ctx),
	});
	registerSubagentRouting(pi, {
		isEnabled: () => preferences?.subagents === true,
		route: (envelope, ctx, signal) => router.subtask(envelope, ctx, signal),
	});
	pi.on("session_start", async (_event, ctx) => {
		try {
			await loadSettings();
		} catch (error) {
			preferences = undefined;
			if (isAuto(ctx.model)) ctx.ui.notify(String(error), "error");
		}
		updateStatus(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		// Refresh application-managed preferences for already-running sessions.
		try {
			await loadSettings();
		} catch {
			preferences = undefined;
		}
		updateStatus(ctx);
	});
	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));
	pi.on("session_tree", (_event, ctx) => updateStatus(ctx));
	const guard = (_event: unknown, ctx: ExtensionContext) => {
		if (!router.hasPending(ctx)) return;
		ctx.ui.notify(
			"Luna classification is still settling. Retry session navigation shortly so its usage stays in this session.",
			"warning",
		);
		return { cancel: true };
	};
	pi.on("session_before_switch", guard);
	pi.on("session_before_fork", guard);
	pi.on("session_before_tree", guard);

	async function setup(ctx: ExtensionContext): Promise<boolean> {
		if (!ctx.hasUI)
			throw new Error("Routing setup requires interactive UI. Run /routing setup in an interactive session.");
		if (!ctx.isIdle()) throw new Error("Wait for or abort the current turn before changing routing preferences.");
		const models = availableModels(ctx);
		const lunaModels = models.filter((model) => /luna/i.test(model.id));
		if (!lunaModels.length)
			throw new Error("No authenticated physical Luna model is available. Sign in to its provider first.");
		const classifier = await chooseModel(
			ctx,
			"Physical Luna classifier (normal completion; uses existing authentication)",
			lunaModels,
			preferences?.classifier,
			"luna",
		);
		if (!classifier) return false;
		const tiers = {} as RoutingSettings["tiers"];
		for (const tier of TIERS) {
			const ref = await chooseModel(
				ctx,
				`${tier}: ${tier === "luna" ? "bounded lookup / mechanical work" : tier === "sol" ? "ordinary coding / conservative fallback" : "deep reasoning / high-impact uncertainty"}`,
				models,
				preferences?.tiers[tier],
				tier,
			);
			if (!ref) return false;
			tiers[tier] = ref;
		}
		const childChoice = await ctx.ui.select(
			"Route authorized bounded subagent assignments too? (Delegation permission is unchanged)",
			["Yes — bounded assignments only", "No — preserve existing subagent selection"],
		);
		if (!childChoice) return false;
		const next: RoutingSettings = {
			version: 1,
			classifier,
			tiers,
			subagents: childChoice.startsWith("Yes"),
			timeoutMs: preferences?.timeoutMs ?? 15_000,
			maxTokens: preferences?.maxTokens ?? 1024,
		};
		for (const ref of [next.classifier, ...Object.values(next.tiers)]) physicalModel(ref, ctx);
		const budgetNotice =
			physicalModel(classifier, ctx).api === "openai-codex-responses"
				? `\nCodex has no hard output-token cap in this adapter; the ${next.timeoutMs}ms deadline still applies.`
				: "";
		if (
			!(await ctx.ui.confirm(
				"Save routing preferences?",
				`Classifier: ${modelName(classifier)}\n${TIERS.map((tier) => `${tier}: ${modelName(tiers[tier])}`).join("\n")}\nSubagents: ${next.subagents ? "bounded assignments" : "unchanged"}\nClassifier calls add usage. Saving does not change your current/default model.${budgetNotice}`,
			))
		)
			return false;
		await store.save(next);
		preferences = next;
		ctx.ui.notify(
			"Routing preferences saved. Use /routing on, or select Auto — Luna routing in /model. Defaults are unchanged.",
			"info",
		);
		updateStatus(ctx);
		return true;
	}

	pi.registerCommand("routing", {
		description: "Opt-in Luna routing: setup | on | off | status | subagents",
		handler: async (args, ctx) => {
			try {
				const action = args.trim() || "status";
				// Setup must also repair invalid preferences, without requiring hand edits.
				try {
					await loadSettings();
				} catch (error) {
					preferences = undefined;
					if (action !== "setup" && action !== "off") throw error;
				}
				if (action === "setup") {
					await setup(ctx);
					return;
				}
				if (action === "on") {
					if (!ctx.isIdle()) throw new Error("Wait for or abort the current turn before enabling routing.");
					if (!preferences && !(await setup(ctx))) return;
					for (const ref of [preferences!.classifier, ...Object.values(preferences!.tiers)]) physicalModel(ref, ctx);
					const model = ctx.modelRegistry.find(ROUTING_PROVIDER, ROUTING_MODEL);
					if (!model || !(await pi.setModel(model)))
						throw new Error("Auto model could not be selected. Reload Pi and try again.");
					ctx.ui.notify("Auto routing enabled for this session. Delegation permissions are unchanged.", "info");
					return;
				}
				if (action === "off") {
					const childNotice = preferences?.subagents
						? " Bounded subagent routing remains on; use /routing subagents to change it."
						: "";
					if (!isAuto(ctx.model)) {
						ctx.ui.notify(
							`Main Auto routing is already off; the selected physical model is unchanged.${childNotice}`,
							"info",
						);
						return;
					}
					if (!ctx.isIdle()) throw new Error("Wait for or abort the current turn before disabling routing.");
					const ref = branchRoutingState(ctx)?.model ?? preferences?.tiers.sol;
					if (!ref) throw new Error("Select a physical model with /model to disable unconfigured Auto routing.");
					if (!(await pi.setModel(physicalModel(ref, ctx))))
						throw new Error("Could not select the physical model. Use /model.");
					ctx.ui.notify(`Main Auto routing off; pinned ${modelName(ref)} for this session.${childNotice}`, "info");
					return;
				}
				if (action === "subagents") {
					if (!ctx.hasUI || !preferences) throw new Error("Use /routing setup interactively first.");
					if (!ctx.isIdle()) throw new Error("Wait for or abort the current turn before changing routing preferences.");
					const choice = await ctx.ui.select("Routing for already-authorized subagents", [
						"On — bounded assignments only",
						"Off — preserve existing selection",
					]);
					if (!choice) return;
					const next = { ...preferences, subagents: choice.startsWith("On") };
					await store.save(next);
					preferences = next;
					updateStatus(ctx);
					ctx.ui.notify(
						`Bounded subagent routing ${next.subagents ? "on" : "off"}, independently of the main model. Delegation permissions are unchanged.`,
						"info",
					);
					return;
				}
				if (action !== "status") throw new Error("Usage: /routing [setup|on|off|status|subagents]");
				const state = branchRoutingState(ctx);
				ctx.ui.notify(
					[
						`Auto: ${isAuto(ctx.model) ? "on" : "off"}. Delegation permissions are unchanged.`,
						...(preferences
							? [
									`Classifier: ${modelName(preferences.classifier)} (${preferences.timeoutMs}ms; ${preferences.maxTokens} output-token budget where supported).`,
									...TIERS.map((tier) => `${tier}: ${modelName(preferences!.tiers[tier])}`),
									`Bounded subagents: ${preferences.subagents ? "on, independently of the main model" : "off"}; full-history forks inherit their parent.`,
								]
							: ["Not configured. Use /routing setup."]),
						...(state ? [`Last task: ${state.tier} → ${modelName(state.model)}. ${clean(state.reason)}`] : []),
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export default registerRouting;
