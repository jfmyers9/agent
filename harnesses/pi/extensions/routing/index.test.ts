import { expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_USAGE_ENTRY_TYPE } from "./accounting";
import { branchRoutingState, registerRouting } from "./index";
import { ROUTING_MODEL, ROUTING_PROVIDER, type RoutingSettings } from "./settings";

function physical(id: string): Model<Api> {
	return {
		provider: "fixture",
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		input: ["text"],
		reasoning: false,
		contextWindow: 32_000,
		maxTokens: 4_096,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
}
const models = [physical("luna"), physical("sol"), physical("astra")];
const auto = { ...physical(ROUTING_MODEL), provider: ROUTING_PROVIDER, api: "pi-virtual" } as Model<Api>;
function settings(): RoutingSettings {
	const ref = (id: string) => ({ provider: "fixture", id });
	return {
		version: 1,
		classifier: ref("luna"),
		tiers: { luna: ref("luna"), sol: ref("sol"), astra: ref("astra") },
		subagents: true,
		timeoutMs: 1_000,
		maxTokens: 1_024,
	};
}
function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: JSON.stringify({
					tier: "luna",
					reason: "Known local edit.",
					insufficient_context: false,
					active_work: { objective: "Correct typo", constraints: [], remaining: ["Apply correction"] },
				}),
			},
		],
		api: models[0].api,
		provider: "fixture",
		model: "luna",
		timestamp: 0,
		stopReason: "stop",
		usage: {
			input: 20,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		},
	};
}

function harness(initial?: RoutingSettings) {
	let preferences = initial;
	let loadError = false;
	let idle = true;
	let selection: Model<Api> = models[1];
	let complete = async () => reply();
	const saved: RoutingSettings[] = [];
	const selected: Model<Api>[] = [];
	const entries: SessionEntry[] = [];
	const notices: { text: string; level?: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const denied = new Set<string>();
	const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
	const commands = new Map<string, any>();
	const virtual: any[] = [];
	const selections: (string | undefined)[] = [];
	const confirmations: boolean[] = [];
	const calls: any[] = [];
	let prompts = 0;
	const context = {
		get model() {
			return selection;
		},
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => "fixture-session", getBranch: () => entries },
		modelRegistry: {
			getAvailable: () => [...models, auto],
			find: (provider: string, id: string) =>
				[...models, auto].find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: Model<Api>) => !denied.has(model.id),
			complete: async (...args: any[]) => {
				calls.push(args);
				return complete();
			},
		},
		ui: {
			select: async (_title: string, _options: string[]) => {
				prompts++;
				return selections.shift();
			},
			confirm: async () => {
				prompts++;
				return confirmations.shift() ?? false;
			},
			notify: (text: string, level?: string) => notices.push({ text, level }),
			setStatus: (key: string, value?: string) => statuses.set(key, value),
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		on: (name: string, callback: any) => handlers.set(name, [...(handlers.get(name) ?? []), callback]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerVirtualModel: (definition: any) => virtual.push(definition),
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data } as SessionEntry),
		setModel: async (model: Model<Api>) => {
			const previousModel = selection;
			selected.push(model);
			selection = model;
			await emit("model_select", { model, previousModel, source: "set" });
			return true;
		},
	};
	registerRouting(pi as unknown as ExtensionAPI, {
		load: async () => {
			if (loadError) throw new Error("Routing preferences are invalid. Use /routing setup to replace them.");
			return preferences;
		},
		save: async (next) => {
			saved.push(next);
			preferences = next;
			loadError = false;
		},
	});
	const command = (args: string) => commands.get("routing").handler(args, context);
	const emit = async (name: string, event: any = {}) => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context));
		return results;
	};
	const wizard = () => {
		selections.push("fixture/luna", "fixture/luna", "fixture/sol", "fixture/astra", "Yes — bounded assignments only");
		confirmations.push(true);
	};
	return {
		context,
		saved,
		selected,
		entries,
		notices,
		statuses,
		denied,
		virtual,
		selections,
		confirmations,
		calls,
		command,
		emit,
		wizard,
		get prompts() {
			return prompts;
		},
		set model(value: Model<Api>) {
			selection = value;
		},
		set idle(value: boolean) {
			idle = value;
		},
		set malformed(value: boolean) {
			loadError = value;
		},
		set completion(value: () => Promise<AssistantMessage>) {
			complete = value;
		},
	};
}

test("status shows the physical model on decisions, resume, tree navigation, and queued reassessment", async () => {
	const h = harness(settings());
	h.model = auto;
	await h.emit("session_start");
	expect(h.statuses.get("routing")).toBe("Auto: ready");
	const route = await h.virtual[0].route(
		{
			model: auto,
			reason: "user",
			thinkingLevel: "low",
			messages: [{ role: "user", content: "Fix typo", timestamp: 1 }],
		},
		h.context,
	);
	expect(h.statuses.get("routing")).toBe("Auto → luna · fixture (luna held)");
	const entry = {
		type: "custom",
		customType: VIRTUAL_MODEL_STATE_ENTRY,
		data: { provider: ROUTING_PROVIDER, modelId: ROUTING_MODEL, state: route.state },
	} as SessionEntry;
	h.entries.push(entry);
	h.statuses.clear();
	await h.emit("session_start");
	expect(h.statuses.get("routing")).toBe("Auto → luna · fixture (luna held)");
	// Stored physical identity wins over current tier mappings.
	(entry as any).data.state = { ...route.state, tier: "sol", model: { provider: "other", id: "pinned-model" } };
	await h.emit("session_tree");
	expect(h.statuses.get("routing")).toBe("Auto → pinned-model · other (sol held)");
	await h.command("reassess");
	expect(h.statuses.get("routing")).toBe("Auto → pinned-model · other (sol held) (reassess queued)");
	expect(h.calls).toHaveLength(1);
	h.model = models[1];
	await h.emit("model_select", { model: models[1] });
	expect(h.statuses.get("routing")).toBe("Child Auto");
});

test("load registers native Auto without enabling, selecting, saving, or classifying", async () => {
	const h = harness();
	expect(h.virtual).toHaveLength(1);
	expect(h.virtual[0]).toMatchObject({ provider: ROUTING_PROVIDER, id: ROUTING_MODEL });
	await h.emit("session_start");
	await h.emit("before_agent_start");
	expect(h.context.model).toBe(models[1]);
	expect(h.selected).toEqual([]);
	expect(h.saved).toEqual([]);
	expect(h.calls).toEqual([]);
	expect(h.statuses.get("routing")).toBeUndefined();
	await h.command("");
	expect(h.notices.at(-1)?.text).toContain("Auto: off");
	expect(h.notices.at(-1)?.text).toContain("Not configured");
});

test("cancel at any setup stage leaves preferences and selected model unchanged", async () => {
	const choices = ["fixture/luna", "fixture/luna", "fixture/sol", "fixture/astra", "Yes — bounded assignments only"];
	for (let stage = 0; stage <= choices.length; stage++) {
		const h = harness(settings());
		h.selections.push(...choices.slice(0, stage));
		h.confirmations.push(false);
		await h.command("setup");
		expect(h.saved).toEqual([]);
		expect(h.selected).toEqual([]);
		expect(h.context.model).toBe(models[1]);
	}
});

test("confirmed setup is atomic and does not implicitly enable main Auto or change model defaults", async () => {
	const h = harness();
	h.wizard();
	await h.command("setup");
	expect(h.saved).toHaveLength(1);
	expect(h.saved[0]).toMatchObject({ ...settings(), timeoutMs: 15_000 });
	expect(h.selected).toEqual([]);
	expect(h.context.model).toBe(models[1]);
	expect(h.notices.at(-1)?.text).toContain("Defaults are unchanged");
});

test("setup repairs malformed preferences without requiring hand edits or enabling Auto", async () => {
	const h = harness();
	h.malformed = true;
	await h.command("status");
	expect(h.notices.at(-1)?.level).toBe("error");
	h.wizard();
	await h.command("setup");
	expect(h.saved).toHaveLength(1);
	expect(h.selected).toEqual([]);
	await h.command("status");
	expect(h.notices.at(-1)?.text).toContain("Classifier: fixture/luna");
});

test("on is explicit, off pins the current branch route, and status never changes selection", async () => {
	const h = harness(settings());
	await h.command("status");
	expect(h.selected).toEqual([]);
	await h.command("on");
	expect(h.selected).toEqual([auto]);
	const state = {
		version: 1,
		taskKey: "task",
		task: "Existing task",
		tier: "astra",
		model: { provider: "fixture", id: "astra" },
		reason: "Deep scope",
	};
	h.entries.push({
		type: "custom",
		customType: VIRTUAL_MODEL_STATE_ENTRY,
		data: { provider: ROUTING_PROVIDER, modelId: ROUTING_MODEL, state },
	} as SessionEntry);
	expect(branchRoutingState(h.context)).toEqual(state);
	await h.command("status");
	expect(h.notices.at(-1)?.text).toContain("Last task: astra");
	await h.command("off");
	expect(h.selected).toEqual([auto, models[2]]);
	await h.command("off");
	expect(h.selected).toHaveLength(2);
	expect(h.saved).toEqual([]);
});

test("no-UI unconfigured on/setup and native routing report actionable failure", async () => {
	const h = harness();
	h.context.hasUI = false;
	for (const action of ["setup", "on"]) {
		await h.command(action);
		expect(h.notices.at(-1)).toMatchObject({ level: "error" });
		expect(h.notices.at(-1)?.text).toContain("interactive");
	}
	await expect(
		h.virtual[0].route(
			{
				model: auto,
				reason: "user",
				thinkingLevel: "off",
				messages: [{ role: "user", content: "Task", timestamp: 1 }],
			},
			h.context,
		),
	).rejects.toThrow("not configured");
	expect(h.selected).toEqual([]);
	expect(h.saved).toEqual([]);
	expect(h.calls).toEqual([]);
});

test("on refuses unauthenticated targets and active turns rather than silently substituting models", async () => {
	const h = harness(settings());
	h.denied.add("astra");
	await h.command("on");
	expect(h.notices.at(-1)?.text).toContain("authentication");
	expect(h.selected).toEqual([]);
	h.denied.clear();
	h.idle = false;
	await h.command("on");
	expect(h.notices.at(-1)?.text).toContain("current turn");
	expect(h.selected).toEqual([]);
});

test("subagent preference changes do not enable the physical parent or alter delegation permission", async () => {
	const h = harness(settings());
	h.selections.push("Off — preserve existing selection");
	await h.command("subagents");
	expect(h.saved[0].subagents).toBe(false);
	expect(h.selected).toEqual([]);
	expect(h.notices.at(-1)?.text).toContain("Delegation permissions are unchanged");
});

test("bounded child routing is independent of the physical parent while explicit child choices bypass it", async () => {
	const h = harness(settings());
	await h.emit("session_start");
	const event = {
		type: "tool_call",
		toolName: "spawn_agent",
		toolCallId: "child",
		input: { task_name: "child", message: "Bounded edit", fork_turns: "none" },
	};
	await h.emit("tool_call", event);
	expect(event.input).toHaveProperty("model", "fixture/luna");
	expect(h.context.model).toBe(models[1]);
	expect(h.selected).toEqual([]);
	expect(h.calls).toHaveLength(1);
	h.model = auto;
	const explicit = { ...event, input: { ...event.input, model: "fixture/astra" } };
	await h.emit("tool_call", explicit);
	expect(explicit.input.model).toBe("fixture/astra");
	expect(h.calls).toHaveLength(1);
	const disabled = harness({ ...settings(), subagents: false });
	await disabled.emit("session_start");
	const unchanged = { ...event, input: { task_name: "child", message: "Bounded edit", fork_turns: "none" } };
	await disabled.emit("tool_call", unchanged);
	expect(unchanged.input).not.toHaveProperty("model");
	expect(disabled.calls).toEqual([]);
});

test("native route definition receives context and records classifier usage exactly once", async () => {
	const h = harness(settings());
	h.model = auto;
	const route = await h.virtual[0].route(
		{
			model: auto,
			reason: "user",
			thinkingLevel: "low",
			messages: [{ role: "user", content: "Correct typo", timestamp: 1 }],
		},
		h.context,
	);
	expect(route.model).toBe(models[0]);
	expect(route.state).toMatchObject({ tier: "luna", model: { provider: "fixture", id: "luna" } });
	expect(h.calls).toHaveLength(1);
	expect(
		h.entries.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE),
	).toHaveLength(1);
	expect(h.notices.at(-1)?.text).toContain("Auto → fixture/luna");
	await h.virtual[0].route(
		{ model: auto, reason: "continuation", thinkingLevel: "low", messages: [], state: route.state },
		h.context,
	);
	expect(h.calls).toHaveLength(1);
});

test("session navigation is guarded until timed-out classifier transport actually settles", async () => {
	const prefs = { ...settings(), timeoutMs: 1 };
	const h = harness(prefs);
	let resolve!: (message: AssistantMessage) => void;
	h.completion = () =>
		new Promise((yes) => {
			resolve = yes;
		});
	await h.virtual[0].route(
		{ model: auto, reason: "user", thinkingLevel: "off", messages: [{ role: "user", content: "Task", timestamp: 1 }] },
		h.context,
	);
	for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"])
		expect(await h.emit(event)).toContainEqual({ cancel: true });
	resolve(reply());
	await Promise.resolve();
	await Promise.resolve();
	for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"])
		expect(await h.emit(event)).not.toContainEqual({ cancel: true });
	expect(
		h.entries.filter((entry) => entry.type === "custom" && entry.customType === CLASSIFIER_USAGE_ENTRY_TYPE),
	).toHaveLength(1);
});

test("explicit reassess/reset queue branch-local requests without selecting models or spending tokens", async () => {
	const h = harness(settings());
	h.model = auto;
	for (const mode of ["reassess", "reset"]) {
		await h.command(mode);
		expect(h.entries.at(-1)).toMatchObject({
			type: "custom",
			customType: "routing:assessment-v1",
			data: { version: 1, mode },
		});
		expect(h.notices.at(-1)?.text).toContain("No tokens spent yet");
		expect(h.statuses.get("routing")).toContain(`${mode} queued`);
		await h.command("status");
		expect(h.notices.at(-1)?.text).toContain(`${mode} queued`);
	}
	expect((h.entries[0] as any).data.id).not.toBe((h.entries[1] as any).data.id);
	expect(h.calls).toEqual([]);
	expect(h.selected).toEqual([]);
	expect(h.saved).toEqual([]);
});

test("assessment commands reject physical selections, active turns, and unsettled transports", async () => {
	const h = harness(settings());
	for (const mode of ["reassess", "reset"]) {
		await h.command(mode);
		expect(h.notices.at(-1)?.text).toContain("Select Auto");
	}
	h.model = auto;
	h.idle = false;
	await h.command("reset");
	expect(h.notices.at(-1)?.text).toContain("settle");
	expect(h.entries).toEqual([]);
	h.idle = true;
	let resolve!: (message: AssistantMessage) => void;
	// Exercise the command after classifier deadline, before transport settlement.
	const timed = harness({ ...settings(), timeoutMs: 1 });
	timed.model = auto;
	timed.completion = () =>
		new Promise((yes) => {
			resolve = yes;
		});
	await timed.virtual[0].route(
		{ model: auto, reason: "user", thinkingLevel: "low", messages: [{ role: "user", content: "Task", timestamp: 1 }] },
		timed.context,
	);
	await timed.command("reassess");
	expect(timed.notices.at(-1)?.text).toContain("settle");
	expect(timed.entries.some((entry) => entry.type === "custom" && entry.customType === "routing:assessment-v1")).toBe(
		false,
	);
	resolve(reply());
	await Promise.resolve();
	await Promise.resolve();
});
test("physical /model choices pin an execution model while keeping Auto selected", async () => {
	const h = harness(settings());
	h.model = auto;
	await h.emit("session_start");
	await h.emit("model_select", { model: models[2], previousModel: auto, source: "set" });
	expect(h.context.model).toBe(auto);
	expect(h.selected).toEqual([auto]);
	expect(h.statuses.get("routing")).toBe("Auto → astra · fixture (manual pin)");
	expect(h.notices.at(-1)?.text).toContain("Auto routing remains selected");
	const request = {
		model: auto,
		reason: "user",
		thinkingLevel: "low",
		messages: [{ role: "user", content: "A small follow-up", timestamp: 1 }],
	};
	const pinned = await h.virtual[0].route(request, h.context);
	expect(pinned.model).toBe(models[2]);
	expect(h.calls).toEqual([]);
	await h.command("reset");
	expect(h.statuses.get("routing")).toContain("reset queued");
	const reassessed = await h.virtual[0].route(request, h.context);
	expect(reassessed.model).toBe(models[0]);
	expect(h.calls).toHaveLength(1);
	expect(h.statuses.get("routing")).toBe("Auto → luna · fixture (luna held)");
});

test("notices and decision receipts distinguish incomplete scope from failed assessments", async () => {
	const h = harness(settings());
	h.model = auto;
	const state = {
		version: 1,
		taskKey: "old",
		task: "A bounded task",
		tier: "luna",
		model: { provider: "fixture", id: "luna" },
		reason: "Previous decision",
	};
	const request = {
		model: auto,
		reason: "user",
		thinkingLevel: "low",
		state,
		messages: [{ role: "user", content: "Implement the UI redesign.", timestamp: 1 }],
	};
	h.completion = async () => ({
		...reply(),
		content: [
			{
				type: "text",
				text: JSON.stringify({
					tier: "sol",
					reason: "The requested prior design is incomplete.",
					insufficient_context: true,
					active_work: {
						objective: "Implement the UI redesign",
						constraints: [],
						remaining: ["Inspect the design and implement"],
					},
				}),
			},
		],
	});
	expect((await h.virtual[0].route(request, h.context)).model).toBe(models[1]);
	expect(h.notices.at(-1)).toMatchObject({ level: "info" });
	expect(h.notices.at(-1)?.text).toContain("Recommended sol");
	expect(h.notices.at(-1)?.text).toContain("using sol");
	expect(h.notices.at(-1)?.text).not.toContain("Unreliable");
	expect(
		h.entries.findLast((entry) => entry.type === "custom" && entry.customType === "routing:decision-v1"),
	).toMatchObject({ data: { assessment: "incomplete", recommendedTier: "sol", tier: "sol" } });
	h.completion = async () => {
		throw new Error("private provider detail");
	};
	expect((await h.virtual[0].route(request, h.context)).model).toBe(models[1]);
	expect(h.notices.at(-1)).toMatchObject({ level: "warning" });
	expect(h.notices.at(-1)?.text).toContain("Assessment failed (error)");
	expect(h.notices.at(-1)?.text).not.toContain("private provider detail");
	expect(
		h.entries.findLast((entry) => entry.type === "custom" && entry.customType === "routing:decision-v1"),
	).toMatchObject({ data: { assessment: "failed", fallback: "error", tier: "sol" } });
});
