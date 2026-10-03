// Scheduler tests backported from luan/agents 0ef2409d.
import { describe, expect, test } from "bun:test";
import {
	MotionScheduler,
	type MotionClock,
	type MotionRenderTarget,
	type MotionTimerHandle,
} from "../node_modules/@luan.sh/pi-libtui/src/motion.ts";

interface FakeTimer extends MotionTimerHandle {
	callback: () => void;
	cadenceMs: number;
	unreferenced: boolean;
	stopped: boolean;
}

class FakeClock implements MotionClock {
	currentMs = 0;
	readonly timers: FakeTimer[] = [];

	now(): number {
		return this.currentMs;
	}

	start(callback: () => void, cadenceMs: number): FakeTimer {
		const timer: FakeTimer = {
			callback,
			cadenceMs,
			unreferenced: false,
			stopped: false,
			unref() {
				this.unreferenced = true;
			},
		};
		this.timers.push(timer);
		return timer;
	}

	stop(handle: MotionTimerHandle): void {
		(handle as FakeTimer).stopped = true;
	}

	tick(cadenceMs: number, nowMs: number): void {
		this.currentMs = nowMs;
		for (const timer of this.timers) {
			if (!timer.stopped && timer.cadenceMs === cadenceMs) timer.callback();
		}
	}
}

describe("MotionScheduler", () => {
	test.each(["render", "frame"] as const)("keeps replacement mounts when a %s callback then throws", (phase) => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let mount: { dispose(): void };
		let replaced = false;
		let frames = 0;
		const replaceAndThrow = () => {
			if (replaced) return;
			replaced = true;
			mount.dispose();
			mount = scheduler.mount(target, options);
			throw new Error("old callback failed after remount");
		};
		const target = {
			requestRender: () => {
				if (phase === "render") replaceAndThrow();
			},
		};
		const options = {
			cadenceMs: 40,
			onFrame: () => {
				frames++;
				if (phase === "frame") replaceAndThrow();
			},
		};
		const keeper = scheduler.mount({ requestRender() {} }, { cadenceMs: 40 });
		mount = scheduler.mount(target, options);
		clock.tick(40, 40);
		expect(frames).toBe(1);
		expect(scheduler.activeMountCount).toBe(2);
		clock.tick(40, 80);
		expect(frames).toBe(2);
		expect(scheduler.activeMountCount).toBe(2);
		mount.dispose();
		keeper.dispose();
		expect(scheduler.activeMountCount).toBe(0);
		expect(scheduler.activeTimerCount).toBe(0);
	});

	test.each(["render", "frame"] as const)("defers mounts replaced during a %s until the next tick", (phase) => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		let frames = 0;
		let replacements = 0;
		let mount: { dispose(): void };
		const replace = () => {
			// Bound the broken implementation so this regression never hangs.
			if (++replacements > 3) throw new Error("tick revisited a new mount");
			mount.dispose();
			mount = scheduler.mount(target, options);
		};
		const target = {
			requestRender() {
				renders++;
				if (phase === "render") replace();
			},
		};
		const options = {
			cadenceMs: 40,
			onFrame() {
				frames++;
				if (phase === "frame") replace();
			},
		};
		const keeper = scheduler.mount({ requestRender() {} }, { cadenceMs: 40 });
		mount = scheduler.mount(target, options);

		clock.tick(40, 40);
		expect({ replacements, frames, renders }).toEqual({
			replacements: 1,
			frames: 1,
			renders: phase === "render" ? 1 : 0,
		});
		expect(scheduler.activeMountCount).toBe(2);
		clock.tick(40, 80);
		expect({ replacements, frames, renders }).toEqual({
			replacements: 2,
			frames: 2,
			renders: phase === "render" ? 2 : 0,
		});
		mount.dispose();
		keeper.dispose();
		expect(scheduler.activeMountCount).toBe(0);
		expect(scheduler.activeTimerCount).toBe(0);
	});

	test("defers callbacks added to an existing target and skips mounts disposed before their turn", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		const frames: string[] = [];
		let added: { dispose(): void } | undefined;
		const target = { requestRender() {} };
		const first = scheduler.mount(target, {
			cadenceMs: 40,
			onFrame() {
				frames.push("first");
				removed.dispose();
				added ??= scheduler.mount(target, { cadenceMs: 40, onFrame: () => frames.push("added") });
			},
		});
		const removed = scheduler.mount(
			{ requestRender: () => frames.push("removed render") },
			{ cadenceMs: 40, onFrame: () => frames.push("removed frame") },
		);
		clock.tick(40, 40);
		expect(frames).toEqual(["first"]);
		clock.tick(40, 80);
		expect(frames).toEqual(["first", "first", "added"]);
		first.dispose();
		added?.dispose();
		expect(scheduler.activeMountCount).toBe(0);
		expect(scheduler.activeTimerCount).toBe(0);
	});

	test("shares unreferenced cadence timers and releases them by reference count", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		const target = { requestRender() {} };
		const first = scheduler.mount(target, { cadenceMs: 80 });
		const second = scheduler.mount(target, { cadenceMs: 80 });

		expect(clock.timers).toHaveLength(1);
		expect(clock.timers[0]!.unreferenced).toBe(true);
		expect(scheduler.activeMountCount).toBe(2);
		let renders = 0;
		const coalescedTarget = { requestRender: () => renders++ };
		const third = scheduler.mount(coalescedTarget, { cadenceMs: 80 });
		const fourth = scheduler.mount(coalescedTarget, { cadenceMs: 80 });
		clock.tick(80, 80);
		expect(renders).toBe(1);
		first.dispose();
		expect(clock.timers[0]!.stopped).toBe(false);
		second.dispose();
		expect(clock.timers[0]!.stopped).toBe(false);
		third.dispose();
		fourth.dispose();
		expect(clock.timers[0]!.stopped).toBe(true);
		expect(scheduler.activeTimerCount).toBe(0);
	});

	test("coalesces target invalidation onto its fastest cadence while advancing slower callbacks", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		const frames: number[] = [];
		const target = { requestRender: () => renders++ };
		const fast = scheduler.mount(target, { cadenceMs: 40 });
		const slow = scheduler.mount(target, { cadenceMs: 100, onFrame: (now) => frames.push(now) });

		clock.tick(100, 100);
		expect(frames).toEqual([100]);
		expect(renders).toBe(0);
		clock.tick(40, 120);
		expect(renders).toBe(1);
		fast.dispose();
		clock.tick(100, 200);
		expect(renders).toBe(2);
		slow.dispose();
	});

	test("coalesces distinct component wrappers that share one host repaint callback", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		const requestRender = () => renders++;
		const first = scheduler.mount({ requestRender }, { cadenceMs: 80 });
		const second = scheduler.mount({ requestRender }, { cadenceMs: 80 });

		clock.tick(80, 80);

		expect(renders).toBe(1);
		first.dispose();
		second.dispose();
	});

	test("preserves the receiver of class-based render targets", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		class MethodTarget implements MotionRenderTarget {
			renders = 0;

			requestRender(): void {
				this.renders += 1;
			}
		}
		const target = new MethodTarget();
		const mount = scheduler.mount(target, { cadenceMs: 80 });

		clock.tick(80, 80);

		expect(target.renders).toBe(1);
		mount.dispose();
	});

	test("reduced motion allocates no timer", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		const mount = scheduler.mount({ requestRender() {} }, { cadenceMs: 40, reducedMotion: true });
		expect(scheduler.activeTimerCount).toBe(0);
		mount.dispose();
	});

	test("pauses and resumes registered animations without dropping them", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		const mount = scheduler.mount({ requestRender: () => renders++ }, { cadenceMs: 40 });

		scheduler.setPaused(true);
		expect(scheduler.activeTimerCount).toBe(0);
		clock.tick(40, 40);
		expect(renders).toBe(0);
		expect(scheduler.activeMountCount).toBe(1);

		scheduler.setPaused(false);
		expect(scheduler.activeTimerCount).toBe(1);
		clock.tick(40, 80);
		expect(renders).toBe(1);
		mount.dispose();
	});

	test("expires abandoned mounts without replaying stale animation frames", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		let frames = 0;
		const mount = scheduler.mount(
			{ requestRender: () => renders++ },
			{ cadenceMs: 40, maxDurationMs: 100, onFrame: () => frames++ },
		);

		clock.tick(40, 80);
		expect({ renders, frames }).toEqual({ renders: 1, frames: 1 });
		clock.tick(40, 100);
		expect({ renders, frames }).toEqual({ renders: 1, frames: 1 });
		expect(scheduler.activeMountCount).toBe(0);
		expect(scheduler.activeTimerCount).toBe(0);
		expect(clock.timers[0]!.stopped).toBe(true);
		mount.dispose();
		expect(scheduler.activeMountCount).toBe(0);
	});

	test("normalizes invalid cadence and retires throwing callbacks", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		scheduler.mount(
			{ requestRender: () => {} },
			{
				cadenceMs: Number.NaN,
				onFrame() {
					throw new Error("broken animation");
				},
			},
		);
		expect(clock.timers[0]!.cadenceMs).toBe(120);
		expect(() => clock.tick(120, 120)).not.toThrow();
		expect(scheduler.activeMountCount).toBe(0);
		expect(scheduler.activeTimerCount).toBe(0);
	});
});
