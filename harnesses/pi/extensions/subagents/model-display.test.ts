import { expect, test } from "bun:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const base = import.meta.resolve("@luan.sh/pi-subagents");
const {
	SubagentCoordinator,
	createRootCoordinator,
	removeRootCoordinator,
	latestSubagentTreeCheckpoint,
	SUBAGENT_STATE_ENTRY_TYPE,
} = await import(new URL("./runtime/coordinator.ts", base).href);
const { listAgentsResult } = await import(new URL("./tools/list-agents/result.ts", base).href);
const { renderAgentMetadata } = await import(new URL("./ui/agent-summary.ts", base).href);

const auto = { provider: "routing", id: "auto" };
const physical = { provider: "fixture", id: "sol" };
const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(id = "sol", thinkingLevel: AssistantMessage["thinkingLevel"] = "medium"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "fixture",
		model: id,
		thinkingLevel,
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function harness(selection = auto, inherited?: AssistantMessage) {
	const manager = SessionManager.inMemory();
	if (inherited) manager.appendMessage(inherited);
	let listener = (_event: any) => {};
	let finish!: (result: any) => void;
	const session = {
		sessionManager: manager,
		getToolDefinition: () => undefined,
		extensionRunner: { getMessageRenderer: () => undefined },
		getSessionStats: () => ({ tokens: { total: 0 } }),
		subscribe: (next: typeof listener) => {
			listener = next;
			return () => {};
		},
		messages: inherited ? [inherited] : [],
		abort: async () => {},
	};
	const coordinator = createRootCoordinator(manager.getSessionId(), {
		maxConcurrency: 2,
		run: (_ctx: any, _message: string, options: any) => {
			options.onRuntimeResolved({ model: selection, thinkingLevel: "low" });
			options.onSessionCreated(session);
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	const updates: any[] = [];
	coordinator.subscribe((update: any) => updates.push(update));
	coordinator.spawn(undefined, {
		taskName: "worker",
		message: "Complete the assigned work",
		pi: {},
		ctx: { cwd: "/tmp", sessionManager: SessionManager.inMemory() },
		agentConfig: { model: selection },
		forkTurns: "none",
	});
	return {
		coordinator,
		updates,
		emit: (event: any) => listener(event),
		snapshot: () => coordinator.snapshot()[0],
		close: () => {
			finish({ session, runtime: { dispose: async () => {} }, responseText: "done" });
			removeRootCoordinator(coordinator.rootSessionId);
		},
	};
}

test("Auto children expose the physical model while streaming, without attributing inherited parent work", () => {
	const h = harness(auto, assistant("astra"));
	try {
		expect(h.snapshot().model).toEqual(auto);
		expect(h.snapshot().selectedModel).toBeUndefined();
		h.emit({ type: "message_start", message: { role: "user", content: "work" } });
		expect(h.snapshot().model).toEqual(auto);
		h.emit({ type: "message_start", message: assistant() });
		const snapshot = h.snapshot();
		expect(snapshot).toMatchObject({ model: physical, selectedModel: auto, thinkingLevel: "medium" });
		expect(h.updates.at(-2)).toMatchObject({ type: "updated", agent: { model: physical } });
		expect(Object.isFrozen(snapshot.model)).toBe(true);

		const listed = listAgentsResult(h.coordinator.snapshot(), undefined);
		expect(listed.details.agents[0]).toMatchObject({
			model: "fixture/sol",
			selectedModel: "routing/auto",
			thinkingLevel: "medium",
		});
		expect(JSON.parse(listed.content[0].text)[0].model).toBe("fixture/sol");
		const colors = { fg: (_tone: string, text: string) => text };
		// Lead with the physical target so narrow rows do not hide it behind Auto.
		expect(renderAgentMetadata(colors, snapshot, snapshot.startedAt).startsWith("fixture/sol (via routing/auto)")).toBe(
			true,
		);
	} finally {
		h.close();
	}
});

test("later child responses update model and thinking without tool messages changing the displayed dispatch", () => {
	const h = harness();
	try {
		h.emit({ type: "message_start", message: { ...assistant(), thinkingLevel: undefined } });
		expect(h.snapshot().thinkingLevel).toBeUndefined();
		h.emit({ type: "message_end", message: assistant("sol", "high") });
		expect(h.snapshot()).toMatchObject({ model: physical, thinkingLevel: "high" });
		h.emit({ type: "message_start", message: assistant("astra", "low") });
		expect(h.snapshot()).toMatchObject({
			model: { provider: "fixture", id: "astra" },
			selectedModel: auto,
			thinkingLevel: "low",
		});
		h.emit({ type: "message_end", message: { role: "toolResult", content: [], toolName: "read" } });
		expect(h.snapshot().model.id).toBe("astra");
		// Pi can synthesize a virtual-model error when routing fails before dispatch.
		h.emit({
			type: "message_end",
			message: { ...assistant(), ...auto, model: "auto", api: "pi-virtual", stopReason: "error" },
		});
		expect(h.snapshot().model.id).toBe("astra");
	} finally {
		h.close();
	}
});

test("checkpoints preserve dispatch display separately from the virtual selection used for follow-ups", () => {
	const h = harness();
	const restored = new SubagentCoordinator("restored");
	try {
		h.emit({ type: "message_end", message: assistant() });
		const saved = h.coordinator.checkpoint().agents[0];
		expect(saved).toMatchObject({
			model: auto,
			thinkingLevel: "low",
			dispatchedModel: physical,
			dispatchedThinkingLevel: "medium",
		});
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(SUBAGENT_STATE_ENTRY_TYPE, { version: 1, agent: saved });
		const checkpoint = latestSubagentTreeCheckpoint(manager.getEntries());
		expect(checkpoint?.agents).toHaveLength(1);
		restored.restore(checkpoint);
		expect(restored.snapshot()[0]).toMatchObject({
			model: physical,
			selectedModel: auto,
			thinkingLevel: "medium",
		});
		expect(restored.checkpoint().agents[0].model).toEqual(auto);
		// Legacy checkpoints remain valid; malformed optional dispatch data does not.
		const legacy = { ...saved, dispatchedModel: undefined, dispatchedThinkingLevel: undefined };
		for (const [agent, valid] of [
			[legacy, true],
			[{ ...saved, dispatchedModel: { provider: 5 } }, false],
			[{ ...saved, dispatchedThinkingLevel: "invalid" }, false],
		] as const) {
			const entries = SessionManager.inMemory();
			entries.appendCustomEntry(SUBAGENT_STATE_ENTRY_TYPE, { version: 1, agent });
			expect(latestSubagentTreeCheckpoint(entries.getEntries())?.agents.length ?? 0).toBe(valid ? 1 : 0);
		}
	} finally {
		h.close();
		restored.dispose();
	}
});

test("physical children keep their existing single-model display", () => {
	const h = harness(physical);
	try {
		h.emit({ type: "message_end", message: assistant() });
		expect(h.snapshot().model).toEqual(physical);
		expect(h.snapshot().selectedModel).toBeUndefined();
		const colors = { fg: (_tone: string, text: string) => text };
		const display = renderAgentMetadata(colors, h.snapshot(), Date.now());
		expect(display).toContain("fixture/sol");
		expect(display).not.toContain("→");
	} finally {
		h.close();
	}
});
