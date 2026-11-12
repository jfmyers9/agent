export const MAX_TIMERS = 20;
export const MAX_INTERVAL_SECONDS = 365 * 24 * 60 * 60;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface TimerClock {
	now(): number;
	// Return an idempotent cancellation function.
	schedule(callback: () => void, delay: number): () => void;
}

export const systemClock: TimerClock = {
	now: () => Date.now(),
	schedule(callback, delay) {
		const handle = setTimeout(callback, delay);
		handle.unref?.();
		return () => clearTimeout(handle);
	},
};

export interface SessionTimer {
	id: string;
	prompt: string;
	intervalSeconds: number;
	nextRunAt: number;
	pending: boolean;
}

/** Fixed-rate timers keep at most one pending tick each, never a catch-up backlog. */
export class TimerScheduler {
	private timers = new Map<string, SessionTimer>();
	private sequence = 0;
	private cancelWake?: () => void;
	private generation = 0;

	constructor(
		private onDue: () => void,
		private clock: TimerClock = systemClock,
	) {}

	create(prompt: string, intervalSeconds: number): SessionTimer {
		if (!prompt.trim()) throw new Error("A non-empty prompt is required.");
		if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > MAX_INTERVAL_SECONDS)
			throw new Error(`interval_seconds must be an integer from 1 to ${MAX_INTERVAL_SECONDS}.`);
		if (this.timers.size >= MAX_TIMERS) throw new Error(`At most ${MAX_TIMERS} session timers may be active.`);
		const timer: SessionTimer = {
			id: `timer-${++this.sequence}`,
			prompt: prompt.trim(),
			intervalSeconds,
			nextRunAt: this.clock.now() + intervalSeconds * 1_000,
			pending: false,
		};
		this.timers.set(timer.id, timer);
		this.arm();
		return { ...timer };
	}

	list(): SessionTimer[] {
		return Array.from(this.timers.values(), (timer) => ({ ...timer }));
	}

	takeDue(): SessionTimer[] {
		const due = this.list().filter((timer) => timer.pending);
		for (const timer of due) this.timers.get(timer.id)!.pending = false;
		return due;
	}

	cancel(id: string): boolean {
		const removed = this.timers.delete(id);
		this.arm();
		return removed;
	}

	clear(): void {
		this.timers.clear();
		this.arm();
	}

	private arm(): void {
		this.cancelWake?.();
		this.cancelWake = undefined;
		const generation = ++this.generation;
		if (!this.timers.size) return;
		const next = Math.min(...Array.from(this.timers.values(), (timer) => timer.nextRunAt));
		this.cancelWake = this.clock.schedule(
			() => {
				// A cancelled callback may already be runnable at a session boundary.
				if (generation !== this.generation) return;
				const now = this.clock.now();
				for (const timer of this.timers.values()) {
					if (timer.nextRunAt > now) continue;
					const interval = timer.intervalSeconds * 1_000;
					timer.pending = true;
					timer.nextRunAt += (Math.floor((now - timer.nextRunAt) / interval) + 1) * interval;
				}
				this.arm();
				this.onDue();
			},
			Math.min(MAX_TIMEOUT_MS, Math.max(0, next - this.clock.now())),
		);
	}
}
