import { describe, expect, test } from "bun:test";
import { installPlannotatorEventGuard } from "./index";

type Handler = (data: unknown) => void;

function fakePi() {
	const listeners = new Map<string, Handler[]>();
	const events = {
		on(channel: string, handler: Handler) {
			const channelListeners = listeners.get(channel) ?? [];
			channelListeners.push(handler);
			listeners.set(channel, channelListeners);
			return () => {
				const current = listeners.get(channel) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
		},
		emit(channel: string, data: unknown) {
			for (const listener of [...(listeners.get(channel) ?? [])]) {
				listener(data);
			}
		},
		clear() {
			listeners.clear();
		},
		count(channel: string) {
			return listeners.get(channel)?.length ?? 0;
		},
	};
	return { pi: { events } as any, events };
}

describe("Plannotator event guard", () => {
	test("keeps one active Plannotator request listener", () => {
		const { pi, events } = fakePi();
		installPlannotatorEventGuard(pi);

		let first = 0;
		let second = 0;
		events.on("plannotator:request", () => {
			first += 1;
		});
		events.on("plannotator:request", () => {
			second += 1;
		});

		events.emit("plannotator:request", {});

		expect(first).toBe(0);
		expect(second).toBe(1);
		expect(events.count("plannotator:request")).toBe(1);
	});

	test("clears stale listeners on reload before new extension listeners register", () => {
		const { pi, events } = fakePi();
		installPlannotatorEventGuard(pi);

		let stale = 0;
		let current = 0;
		events.on("plannotator:request", () => {
			stale += 1;
		});

		installPlannotatorEventGuard(pi);
		events.on("plannotator:request", () => {
			current += 1;
		});
		events.emit("plannotator:request", {});

		expect(stale).toBe(0);
		expect(current).toBe(1);
		expect(events.count("plannotator:request")).toBe(1);
	});

	test("does not collapse unrelated event channels", () => {
		const { pi, events } = fakePi();
		installPlannotatorEventGuard(pi);

		let calls = 0;
		events.on("other", () => {
			calls += 1;
		});
		events.on("other", () => {
			calls += 1;
		});
		events.emit("other", {});

		expect(calls).toBe(2);
		expect(events.count("other")).toBe(2);
	});
});
