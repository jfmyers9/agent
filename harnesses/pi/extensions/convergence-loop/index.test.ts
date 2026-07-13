import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import convergenceLoopExtension, {
	buildLoopInstructions,
	COMPLETION_MARKER,
	DEFAULT_MAX_ITERATIONS,
	getAssistantOutcome,
	hasCompletionMarker,
	parseGoalCommand,
} from "./index";

function assistant(text: string, stopReason = "stop"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
	} as AgentMessage;
}

function createHarness() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const userMessages: Array<{ content: unknown; options: unknown }> = [];
	const customMessages: Array<{ message: any; options: any }> = [];
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	let idle = true;
	let pending = false;

	const pi = {
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		on(event: string, handler: (event: any, ctx: any) => any) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		sendUserMessage(content: unknown, options?: unknown) {
			userMessages.push({ content, options });
		},
		sendMessage(message: any, options?: any) {
			customMessages.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: {
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	};

	convergenceLoopExtension(pi);

	return {
		commands,
		handlers,
		userMessages,
		customMessages,
		statuses,
		notifications,
		ctx,
		setIdle(value: boolean) {
			idle = value;
		},
		setPending(value: boolean) {
			pending = value;
		},
		emit(event: string, payload: any) {
			return Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
		},
	};
}

describe("convergence loop command parsing", () => {
	test("parses default and bounded max iterations", () => {
		expect(parseGoalCommand("ship the fix")).toEqual({
			action: "start",
			goal: "ship the fix",
			maxIterations: DEFAULT_MAX_ITERATIONS,
		});
		expect(parseGoalCommand("--max 12 ship the fix")).toEqual({
			action: "start",
			goal: "ship the fix",
			maxIterations: 12,
		});
		expect(parseGoalCommand("--max=3 ship the fix")).toEqual({
			action: "start",
			goal: "ship the fix",
			maxIterations: 3,
		});
	});

	test("parses controls and rejects unsafe limits", () => {
		expect(parseGoalCommand("status")).toEqual({ action: "status" });
		expect(parseGoalCommand("stop")).toEqual({ action: "stop" });
		expect(parseGoalCommand("--max 0 no").action).toBe("error");
		expect(parseGoalCommand("--max 51 no").action).toBe("error");
		expect(parseGoalCommand("--max nope no").action).toBe("error");
		expect(parseGoalCommand("--max 4").action).toBe("error");
	});
});

describe("convergence loop protocol", () => {
	test("extracts only assistant text and recognizes the completion marker", () => {
		const outcome = getAssistantOutcome([
			{ role: "user", content: "goal", timestamp: 1 } as AgentMessage,
			assistant(`Verified. ${COMPLETION_MARKER}`),
		]);
		expect(outcome).toEqual({ stopReason: "stop", text: `Verified. ${COMPLETION_MARKER}` });
		expect(hasCompletionMarker(outcome?.text ?? "")).toBe(true);
		expect(hasCompletionMarker("still working")).toBe(false);
	});

	test("includes the objective, bound, and completion contract", () => {
		const prompt = buildLoopInstructions({ goal: "fix tests", iteration: 2, maxIterations: 5 });
		expect(prompt).toContain("fix tests");
		expect(prompt).toContain("iteration 2 of 5");
		expect(prompt).toContain(COMPLETION_MARKER);
	});
});

describe("convergence loop extension", () => {
	test("registers aliases, starts a goal, and injects per-turn instructions", async () => {
		const harness = createHarness();
		expect([...harness.commands.keys()]).toEqual(["goal", "loop"]);

		await harness.commands.get("goal").handler("--max 3 make tests pass", harness.ctx);
		expect(harness.userMessages).toEqual([{ content: "make tests pass", options: undefined }]);
		expect(harness.statuses.at(-1)).toBe("goal 1/3");

		const [result] = await harness.emit("before_agent_start", { systemPrompt: "base" });
		expect(result.systemPrompt).toContain("base");
		expect(result.systemPrompt).toContain("make tests pass");
	});

	test("queues bounded hidden follow-ups until completion", async () => {
		const harness = createHarness();
		await harness.commands.get("goal").handler("--max 3 finish", harness.ctx);

		await harness.emit("agent_end", { messages: [assistant("progress")] });
		expect(harness.customMessages).toHaveLength(0);
		await harness.emit("agent_settled", {});
		expect(harness.customMessages).toHaveLength(1);
		expect(harness.customMessages[0]?.message.display).toBe(false);
		expect(harness.customMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(harness.statuses.at(-1)).toBe("goal 2/3");

		await harness.emit("agent_end", { messages: [assistant(`done ${COMPLETION_MARKER}`)] });
		await harness.emit("agent_settled", {});
		expect(harness.customMessages).toHaveLength(1);
		expect(harness.statuses.at(-1)).toBeUndefined();
		expect(harness.notifications.at(-1)?.message).toContain("converged in 2 iterations");
	});

	test("stops at the limit, on abort, and on new user input", async () => {
		const limited = createHarness();
		await limited.commands.get("goal").handler("--max 1 finish", limited.ctx);
		await limited.emit("agent_end", { messages: [assistant("not done")] });
		await limited.emit("agent_settled", {});
		expect(limited.customMessages).toHaveLength(0);
		expect(limited.notifications.at(-1)?.message).toContain("1-iteration limit");

		const aborted = createHarness();
		await aborted.commands.get("goal").handler("finish", aborted.ctx);
		await aborted.emit("agent_end", { messages: [assistant("", "aborted")] });
		await aborted.emit("agent_settled", {});
		expect(aborted.customMessages).toHaveLength(0);
		expect(aborted.notifications.at(-1)?.message).toContain("aborted");

		const interrupted = createHarness();
		await interrupted.commands.get("goal").handler("finish", interrupted.ctx);
		await interrupted.emit("input", { source: "interactive" });
		await interrupted.emit("agent_end", { messages: [assistant("not done")] });
		await interrupted.emit("agent_settled", {});
		expect(interrupted.customMessages).toHaveLength(0);
		expect(interrupted.notifications.at(-1)?.message).toContain("new user input");

		const queued = createHarness();
		await queued.commands.get("goal").handler("finish", queued.ctx);
		queued.setPending(true);
		await queued.emit("agent_end", { messages: [assistant("not done")] });
		await queued.emit("agent_settled", {});
		expect(queued.customMessages).toHaveLength(0);
		expect(queued.notifications.at(-1)?.message).toContain("another message is queued");
	});

	test("uses the final outcome after Pi retries a low-level run", async () => {
		const harness = createHarness();
		await harness.commands.get("goal").handler("finish", harness.ctx);
		await harness.emit("agent_end", { messages: [assistant("", "error")] });
		await harness.emit("agent_end", { messages: [assistant("recovered and progressing")] });
		await harness.emit("agent_settled", {});
		expect(harness.customMessages).toHaveLength(1);
		expect(harness.notifications).toHaveLength(0);
	});

	test("does not replace a running turn with a new goal", async () => {
		const harness = createHarness();
		harness.setIdle(false);
		await harness.commands.get("loop").handler("new goal", harness.ctx);
		expect(harness.userMessages).toHaveLength(0);
		expect(harness.notifications.at(-1)?.type).toBe("warning");
	});
});
