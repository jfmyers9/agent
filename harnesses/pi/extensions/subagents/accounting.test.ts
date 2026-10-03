import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const base = import.meta.resolve("@luan.sh/pi-subagents");
const {
	SessionCostLedger,
	entryCost,
	SubagentCoordinator,
	createRootCoordinator,
	removeRootCoordinator,
	latestSubagentTreeCheckpoint,
	SUBAGENT_STATE_ENTRY_TYPE,
} = await import(new URL("./runtime/coordinator.ts", base).href);
const usage = (total = Number.NaN): Usage => ({
	input: 1_000_000,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1_000_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const assistant = (model = "cheap", responseModel?: string): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: "anthropic-messages",
	provider: "example",
	model,
	responseModel,
	usage: usage(),
	stopReason: "stop",
	timestamp: 1,
});
const models = new Map([
	["cheap", { cost: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2.5 } }],
	["expensive", { cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 } }],
]);
const registry = { find: (provider: string, id: string) => (provider === "example" ? models.get(id) : undefined) };

test("list prices use each message's model, preserve telemetry, and support response-model overrides", () => {
	const manager = SessionManager.inMemory();
	const message = assistant("cheap", "expensive");
	manager.appendMessage(message);
	expect(entryCost(manager.getEntries()[0], registry)).toBe(10);
	expect(message.usage.cost.total).toBeNaN();
	const reported = assistant();
	reported.usage = usage(0);
	expect(entryCost({ type: "message", message: reported }, registry)).toBe(0);
	reported.usage = usage(0.5);
	expect(entryCost({ type: "message", message: reported }, registry)).toBe(0.5);
	manager.appendMessage(assistant("cheap", "cheap-dated-alias"));
	expect(entryCost(manager.getEntries()[1], registry)).toBe(2);
	const unknown = assistant("unknown");
	unknown.usage = usage(7);
	manager.appendMessage(unknown);
	expect(entryCost(manager.getEntries()[2], registry)).toBe(7);
});

test("ledger counts standalone, tool and summary usage once across branches, excluding inherited history", () => {
	const manager = SessionManager.inMemory();
	const inherited = manager.appendMessage(assistant("expensive"));
	const ledger = new SessionCostLedger(manager.getEntries(), registry);
	manager.appendMessage(assistant());
	manager.appendUsage("cache_warm", "example", "expensive", usage());
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "lookup",
		content: [],
		isError: false,
		timestamp: 2,
		usage: usage(3),
	});
	manager.appendCompaction("summary", inherited, 10, undefined, false, usage(4));
	manager.branchWithSummary(inherited, "branch", undefined, false, usage(5));
	expect(ledger.collect(manager.getEntries())).toBe(24);
	expect(ledger.collect(manager.getEntries())).toBe(0);
	manager.branch(inherited);
	manager.appendMessage(assistant());
	expect(ledger.collect(manager.getEntries())).toBe(2);
});

let harnessId = 0;
function harness(initial?: ReturnType<typeof SessionManager.inMemory>, rootSessionDir?: string) {
	const manager = initial ?? SessionManager.inMemory();
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
		messages: [],
		abort: async () => {},
	};
	const run = (_ctx: any, _message: string, options: any) => {
		options.onSessionCreated(session);
		return new Promise((resolve) => {
			finish = resolve;
		});
	};
	const coordinator = createRootCoordinator(`accounting-root-${++harnessId}`, {
		run,
		maxConcurrency: 2,
		rootSessionDir,
	});
	const ctx = { cwd: "/tmp", sessionManager: SessionManager.inMemory(), modelRegistry: registry };
	const request = { taskName: "worker", message: "work", pi: {}, ctx, agentConfig: {}, forkTurns: "none" };
	return {
		manager,
		coordinator,
		request,
		ctx,
		emit: (event: any) => listener(event),
		finish: () => finish({ session, runtime: { dispose: async () => {} }, responseText: "done" }),
	};
}

test("coordinator handles real persistence ordering, event-free usage and restored follow-up baselines", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant("expensive"));
	const h = harness(manager);
	h.coordinator.spawn(undefined, h.request);
	const message = assistant();
	// Pi emits message_end before appending its entry.
	h.emit({ type: "message_end", message });
	manager.appendMessage(message);
	h.emit({ type: "turn_end" });
	h.emit({ type: "turn_end" });
	expect(h.coordinator.snapshot()[0].cost).toBe(2);
	manager.appendUsage("cache_warm", "example", "expensive", usage());
	expect(h.coordinator.persistedAgent("/root/worker").cost).toBe(12);
	h.finish();
	await Promise.resolve();
	await Promise.resolve();
	const checkpoint = h.coordinator.checkpoint();
	expect(checkpoint.agents[0].cost).toBe(12);
	const resumed = harness(manager);
	resumed.coordinator.restore(checkpoint, { ctx: resumed.ctx, pi: {} });
	await resumed.coordinator.followUp(undefined, "/root/worker", "continue");
	expect(resumed.coordinator.snapshot()[0].cost).toBe(12);
	manager.appendMessage(assistant());
	resumed.emit({ type: "agent_settled" });
	expect(resumed.coordinator.snapshot()[0].cost).toBe(14);
	resumed.finish();
	await Promise.resolve();
	removeRootCoordinator(h.coordinator.rootSessionId);
	removeRootCoordinator(resumed.coordinator.rootSessionId);
});

test("root restoration retains off-branch agents and reserves their task names", () => {
	const h = harness();
	// Queued-only coordinator gives a complete valid persisted record without a live session.
	const queued = new SubagentCoordinator("root", { maxConcurrency: 1 });
	queued.spawn(undefined, h.request);
	const saved = { ...queued.checkpoint().agents[0], cost: 8 };
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	manager.appendCustomEntry(SUBAGENT_STATE_ENTRY_TYPE, { version: 1, agent: saved });
	manager.branch(root);
	expect(latestSubagentTreeCheckpoint(manager.getBranch())).toBeUndefined();
	const restored = new SubagentCoordinator("restored", { maxConcurrency: 1 });
	restored.restore(latestSubagentTreeCheckpoint(manager.getEntries()));
	expect(restored.snapshot()[0].cost).toBe(8);
	expect(() => restored.spawn(undefined, h.request)).toThrow();
	// Protect the extension's caller: using getBranch here silently loses spend.
	expect(readFileSync(new URL("./extension.ts", base), "utf8")).toContain(
		"latestSubagentTreeCheckpoint(context.sessionManager.getEntries())",
	);
	queued.dispose();
	restored.dispose();
	removeRootCoordinator(h.coordinator.rootSessionId);
});

test("restoration reconciles crash-gap transcript costs before follow-up and checkpoints the recovered watermark", async () => {
	const rootSessionDir = mkdtempSync(join(tmpdir(), "pi-accounting-"));
	const childDir = join(rootSessionDir, "subagents", "worker");
	mkdirSync(childDir, { recursive: true });
	const manager = SessionManager.create(rootSessionDir, childDir);
	const inheritedMessage = assistant();
	inheritedMessage.usage = usage(100);
	const inherited = manager.appendMessage(inheritedMessage);
	const h = harness(manager, rootSessionDir);
	const restored = harness(manager, rootSessionDir);
	const repeat = new SubagentCoordinator("repeat", { rootSessionDir });
	try {
		h.coordinator.spawn(undefined, h.request);
		const charged = assistant();
		charged.usage = usage(2);
		manager.appendMessage(charged);
		const checkpoint = h.coordinator.checkpoint();
		expect(checkpoint.agents[0].cost).toBe(2);
		expect(checkpoint.agents[0].costLastEntryId).toBe(manager.getEntries().at(-1)?.id);
		// All four writes reach the child transcript, but the parent never checkpoints them.
		manager.appendUsage("cache_warm", "example", "cheap", usage(3));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "gap",
			toolName: "lookup",
			content: [],
			isError: false,
			timestamp: 3,
			usage: usage(4),
		});
		manager.appendCompaction("summary", inherited, 10, undefined, false, usage(5));
		manager.branchWithSummary(inherited, "branch", undefined, false, usage(6));
		restored.coordinator.restore(checkpoint, { ctx: restored.ctx, pi: {} });
		expect(restored.coordinator.snapshot()[0].cost).toBe(20);
		expect(restored.coordinator.snapshot()[0].cost).toBe(20);
		const recovered = restored.coordinator.checkpoint();
		expect(recovered.agents[0].costLastEntryId).toBe(manager.getEntries().at(-1)?.id);
		repeat.restore(recovered);
		expect(repeat.snapshot()[0].cost).toBe(20);
		await restored.coordinator.followUp(undefined, "/root/worker", "continue");
		expect(restored.coordinator.snapshot()[0].cost).toBe(20);
		const next = assistant();
		next.usage = usage(2);
		manager.appendMessage(next);
		expect(restored.coordinator.checkpoint().agents[0].cost).toBe(22);
		restored.finish();
		h.finish();
		await Promise.resolve();
	} finally {
		removeRootCoordinator(h.coordinator.rootSessionId);
		removeRootCoordinator(restored.coordinator.rootSessionId);
		repeat.dispose();
		rmSync(rootSessionDir, { recursive: true, force: true });
	}
});

test("legacy or unresolvable watermarks exclude existing transcript history; null means known empty baseline", () => {
	const rootSessionDir = mkdtempSync(join(tmpdir(), "pi-accounting-"));
	const childDir = join(rootSessionDir, "subagents", "worker");
	mkdirSync(childDir, { recursive: true });
	const manager = SessionManager.create(rootSessionDir, childDir);
	const message = assistant();
	message.usage = usage(7);
	manager.appendMessage(message);
	const h = harness(manager, rootSessionDir);
	try {
		h.coordinator.spawn(undefined, h.request);
		const saved = h.coordinator.checkpoint().agents[0];
		for (const [watermark, expected] of [
			[undefined, 2],
			["missing-entry", 2],
			[null, 9],
		] as const) {
			const restored = new SubagentCoordinator("legacy", { rootSessionDir });
			try {
				restored.restore({ version: 1, agents: [{ ...saved, cost: 2, costLastEntryId: watermark }] });
				expect(restored.snapshot()[0].cost).toBe(expected);
				expect(restored.checkpoint().agents[0].costLastEntryId).toBe(manager.getEntries().at(-1)?.id);
			} finally {
				restored.dispose();
			}
		}
		const missingTranscript = new SubagentCoordinator("missing", { rootSessionDir });
		missingTranscript.restore({
			version: 1,
			agents: [{ ...saved, cost: 2, transcriptFile: join(childDir, "missing.jsonl") }],
		});
		expect(missingTranscript.snapshot()[0].cost).toBe(2);
		missingTranscript.dispose();
	} finally {
		removeRootCoordinator(h.coordinator.rootSessionId);
		rmSync(rootSessionDir, { recursive: true, force: true });
	}
});
