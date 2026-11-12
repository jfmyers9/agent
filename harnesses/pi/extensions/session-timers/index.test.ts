import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionTimers } from "./index";
import { MAX_INTERVAL_SECONDS, MAX_TIMERS, type TimerClock, TimerScheduler } from "./scheduler";

class FakeClock implements TimerClock {
	time = 0;
	wakes = new Set<{ at: number; callback: () => void }>();
	now = () => this.time;
	schedule(callback: () => void, delay: number): () => void {
		const wake = { at: this.time + delay, callback };
		this.wakes.add(wake);
		return () => this.wakes.delete(wake);
	}
	advance(milliseconds: number): void {
		this.time += milliseconds;
		// Model a delayed event loop: a wake may execute much later than requested.
		for (const wake of [...this.wakes]) {
			if (wake.at > this.time) continue;
			this.wakes.delete(wake);
			wake.callback();
		}
	}
}

function harness() {
	const clock = new FakeClock();
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const messages: any[] = [];
	const notifications: string[] = [];
	const statuses: (string | undefined)[] = [];
	let tool: any;
	let command: any;
	let idle = true;
	let pending = false;
	let deliveryError = false;
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (definition: any) => {
			tool = definition;
		},
		registerCommand: (_name: string, definition: any) => {
			command = definition;
		},
		sendMessage(message: any, options: any) {
			if (deliveryError) throw new Error("delivery unavailable");
			messages.push({ message, options });
			idle = false;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: {},
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, status: string | undefined) => statuses.push(status),
		},
	};
	registerSessionTimers(pi, clock);
	const emit = (event: string) => handlers.get(event)?.({}, ctx);
	emit("session_start");
	return {
		clock,
		ctx,
		messages,
		notifications,
		statuses,
		emit,
		call: async (args: any, signal?: AbortSignal) => {
			const result = await tool.execute("call-1", args, signal, undefined, ctx);
			return JSON.parse(result.content[0].text);
		},
		command: (args: string) => command.handler(args, ctx),
		busy: () => {
			idle = false;
		},
		settle: () => {
			idle = true;
			emit("agent_settled");
		},
		setPending: (value: boolean) => {
			pending = value;
		},
		failDelivery: (value: boolean) => {
			deliveryError = value;
		},
	};
}

describe("timer scheduler", () => {
	test("first fires after one interval and coalesces delayed ticks on a fixed cadence", () => {
		const clock = new FakeClock();
		let dueCalls = 0;
		const scheduler = new TimerScheduler(() => dueCalls++, clock);
		const timer = scheduler.create(" check build ", 300);
		expect(timer.prompt).toBe("check build");
		expect(timer.nextRunAt).toBe(300_000);
		clock.advance(299_999);
		expect(dueCalls).toBe(0);
		clock.advance(1);
		expect(scheduler.list()[0]?.pending).toBe(true);
		clock.advance(1_250_000);
		expect(scheduler.takeDue()).toHaveLength(1);
		expect(scheduler.list()[0]?.nextRunAt).toBe(1_800_000);
		expect(scheduler.takeDue()).toEqual([]);
		expect(clock.wakes.size).toBe(1);
	});

	test("cancel and clear invalidate even already-runnable callbacks", () => {
		const clock = new FakeClock();
		let dueCalls = 0;
		const scheduler = new TimerScheduler(() => dueCalls++, clock);
		const timer = scheduler.create("task", 1);
		const staleWake = [...clock.wakes][0]!;
		expect(scheduler.cancel(timer.id)).toBe(true);
		expect(scheduler.cancel(timer.id)).toBe(false);
		clock.time = 5_000;
		staleWake.callback();
		expect(dueCalls).toBe(0);
		const next = scheduler.create("new task", 1);
		expect(next.id).not.toBe(timer.id);
		scheduler.clear();
		expect(clock.wakes.size).toBe(0);
	});

	test("validates intervals, prompts, and count before allocating resources", () => {
		const clock = new FakeClock();
		const scheduler = new TimerScheduler(() => {}, clock);
		for (const interval of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_INTERVAL_SECONDS + 1])
			expect(() => scheduler.create("task", interval)).toThrow("interval_seconds");
		expect(() => scheduler.create("  ", 1)).toThrow("non-empty");
		for (let i = 0; i < MAX_TIMERS; i++) scheduler.create("task", 1);
		expect(() => scheduler.create("task", 1)).toThrow("At most");
		expect(clock.wakes.size).toBe(1);
	});

	test("long intervals use bounded timeout chunks without firing early", () => {
		const clock = new FakeClock();
		const scheduler = new TimerScheduler(() => {}, clock);
		scheduler.create("annual task", MAX_INTERVAL_SECONDS);
		expect([...clock.wakes][0]?.at).toBe(2_147_483_647);
		clock.advance(2_147_483_647);
		expect(scheduler.takeDue()).toEqual([]);
		clock.advance(MAX_INTERVAL_SECONDS * 1_000 - clock.time);
		expect(scheduler.takeDue()).toHaveLength(1);
	});
});

describe("session timer extension", () => {
	test("creates, lists, dispatches a visible follow-up, and cancels conversationally", async () => {
		const h = harness();
		const { created } = await h.call({ action: "create", prompt: "Check the build", interval_seconds: 300 });
		expect(h.messages).toEqual([]);
		expect((await h.call({ action: "list" })).timers).toEqual([created]);
		h.clock.advance(300_000);
		expect(h.messages).toHaveLength(1);
		expect(h.messages[0].message).toMatchObject({ customType: "session-timer", display: true });
		expect(h.messages[0].message.content).toContain("Check the build");
		expect(h.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(await h.call({ action: "cancel", id: created.id })).toEqual({ id: created.id, cancelled: true });
		h.settle();
		h.clock.advance(600_000);
		expect(h.messages).toHaveLength(1);
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	test("busy work and queued user messages take priority; ticks batch and coalesce", async () => {
		const h = harness();
		await h.call({ action: "create", prompt: "First task", interval_seconds: 5 });
		await h.call({ action: "create", prompt: "Second task", interval_seconds: 10 });
		h.busy();
		h.clock.advance(60_000);
		expect(h.messages).toEqual([]);
		expect(h.statuses.at(-1)).toContain("2 due");
		h.setPending(true);
		h.settle();
		expect(h.messages).toEqual([]);
		h.setPending(false);
		h.settle();
		expect(h.messages).toHaveLength(1);
		expect(h.messages[0].message.details.timers).toHaveLength(2);
		h.clock.advance(60_000);
		expect(h.messages).toHaveLength(1);
		h.settle();
		expect(h.messages).toHaveLength(2);
		expect(h.messages[1].message.details.timers).toHaveLength(2);
	});

	test("cancelling a pending tick prevents its later dispatch", async () => {
		const h = harness();
		const { created } = await h.call({ action: "create", prompt: "task", interval_seconds: 1 });
		h.busy();
		h.clock.advance(1_000);
		await h.command(`cancel ${created.id}`);
		h.settle();
		expect(h.messages).toEqual([]);
	});

	for (const boundary of ["session_start", "session_tree", "session_shutdown"]) {
		test(`${boundary} clears resources and does not restore historical timers`, async () => {
			const h = harness();
			await h.call({ action: "create", prompt: "task", interval_seconds: 1 });
			h.emit(boundary);
			expect(h.clock.wakes.size).toBe(0);
			h.clock.advance(60_000);
			h.settle();
			expect(h.messages).toEqual([]);
			h.emit("session_start");
			expect((await h.call({ action: "list" })).timers).toEqual([]);
		});
	}

	test("manual listing, clear, and usage are available without a model turn", async () => {
		const h = harness();
		await h.call({ action: "create", prompt: "task", interval_seconds: 300 });
		await h.command("");
		expect(h.notifications.at(-1)).toContain("timer-1: every 300s");
		await h.command("cancel missing");
		expect(h.notifications).toContain("No timer found: missing");
		await h.command("invalid");
		expect(h.notifications.at(-1)).toContain("Usage:");
		await h.command("clear");
		expect(h.clock.wakes.size).toBe(0);
		expect(h.messages).toEqual([]);
	});

	test("delivery failures do not escape timer callbacks or retry in a hot loop", async () => {
		const h = harness();
		await h.call({ action: "create", prompt: "task", interval_seconds: 5 });
		h.failDelivery(true);
		h.clock.advance(5_000);
		expect(h.notifications.at(-1)).toContain("delivery unavailable");
		h.failDelivery(false);
		h.settle();
		expect(h.messages).toEqual([]);
		h.clock.advance(5_000);
		expect(h.messages).toHaveLength(1);
	});

	test("rejects incomplete, aborted, one-shot, and stale-session calls", async () => {
		const h = harness();
		await expect(h.call({ action: "create", prompt: "task" })).rejects.toThrow("requires");
		await expect(h.call({ action: "cancel" })).rejects.toThrow("requires");
		await expect(
			h.call({ action: "create", prompt: "task", interval_seconds: 5 }, AbortSignal.abort()),
		).rejects.toThrow();
		for (const mode of ["print", "json"]) {
			h.ctx.mode = mode;
			await expect(h.call({ action: "create", prompt: "task", interval_seconds: 5 })).rejects.toThrow(
				"live TUI or RPC",
			);
		}
		h.ctx.mode = "tui";
		h.emit("session_shutdown");
		await expect(h.call({ action: "list" })).rejects.toThrow("No active");
		expect(h.clock.wakes.size).toBe(0);
	});

	test("RPC sessions can schedule without a UI", async () => {
		const h = harness();
		h.ctx.mode = "rpc";
		h.ctx.hasUI = false;
		await h.call({ action: "create", prompt: "task", interval_seconds: 5 });
		h.clock.advance(5_000);
		expect(h.messages).toHaveLength(1);
	});
});
