import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { MAX_TIMERS, type SessionTimer, type TimerClock } from "./scheduler";
import { formatTimerDuration, renderTimerWidget, TimerWidget } from "./widget";

const theme = {
	name: "timer-widget-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as unknown as Theme;

const timer: SessionTimer = {
	id: "timer-1",
	prompt: "Check the build",
	intervalSeconds: 300,
	nextRunAt: 300_000,
	pending: false,
};

describe("timer panel rendering", () => {
	test("uses compact durations without rounding countdowns down early", () => {
		for (const [seconds, expected] of [
			[0, "0s"],
			[-10, "0s"],
			[0.1, "1s"],
			[60, "1m"],
			[300, "5m"],
			[90_061, "1d 1h 1m 1s"],
		] as const)
			expect(formatTimerDuration(seconds)).toBe(expected);
	});

	test("shows the same header, tree rows, and muted metadata structure as agents", () => {
		const lines = renderTimerWidget([timer], theme, 160, 1_000).map(Bun.stripANSI);
		expect(lines[0]).toContain("Timers · 1 scheduled · /timers");
		expect(lines[1]).toContain("└─");
		expect(lines[1]).toContain("timer-1 · every 5m · next in 4m 59s · Check the build");
	});

	test("pending timers show why they have not fired, not the next interval countdown", () => {
		const rendered = Bun.stripANSI(renderTimerWidget([{ ...timer, pending: true }], theme, 160, 310_000).join("\n"));
		expect(rendered).toContain("1 due");
		expect(rendered).toContain("due · waiting for idle");
		expect(rendered).not.toContain("next in");
	});

	test("fits narrow terminals and sanitizes multiline and terminal-control previews", () => {
		const unsafe = { ...timer, prompt: "Build\n\tcheck\r\x1b[2J\x1b[31m紅色 🧪" };
		for (const width of [1, 2, 5, 20, 80, 160]) {
			const lines = renderTimerWidget([unsafe], theme, width, 0);
			expect(lines).toHaveLength(2);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toMatch(/[\n\r\t]/);
				expect(line).not.toContain("\x1b[2J");
			}
		}
		expect(renderTimerWidget([timer], theme, 0, 0)).toEqual([]);
		expect(renderTimerWidget([], theme, 100, 0)).toEqual([]);
	});

	test("bounds panel height and points to the full list", () => {
		const timers = Array.from({ length: MAX_TIMERS }, (_, i) => ({ ...timer, id: `timer-${i + 1}` }));
		const lines = renderTimerWidget(timers, theme, 160, 0).map(Bun.stripANSI);
		expect(lines).toHaveLength(13);
		expect(lines.at(-1)).toContain("+9 more · /timers to list all");
	});
});

function harness() {
	let now = 0;
	const wakes = new Set<() => void>();
	const clock: TimerClock = {
		now: () => now,
		schedule(callback) {
			wakes.add(callback);
			return () => {
				wakes.delete(callback);
			};
		},
	};
	let factory: ((tui: TUI, theme: Theme) => Component & { dispose?: () => void }) | undefined;
	let mounts = 0;
	let renders = 0;
	const ctx = {
		hasUI: true,
		ui: {
			setWidget(_key: string, content: typeof factory) {
				factory = content;
				if (content) mounts++;
			},
		},
	} as unknown as ExtensionContext;
	const widget = new TimerWidget(clock);
	return {
		ctx,
		widget,
		wakes,
		mount: () => factory!({ requestRender: () => renders++ } as unknown as TUI, theme),
		get mounts() {
			return mounts;
		},
		get renders() {
			return renders;
		},
		get factory() {
			return factory;
		},
		tick() {
			now += 1_000;
			for (const wake of [...wakes]) {
				wakes.delete(wake);
				wake();
			}
		},
	};
}

describe("timer panel lifecycle", () => {
	test("mounts once, refreshes countdowns, updates due state, and clears its wake", () => {
		const h = harness();
		h.widget.update(h.ctx, [timer]);
		// No UI-only wake until a client mounts the component factory.
		expect(h.wakes.size).toBe(0);
		const component = h.mount();
		expect(h.wakes.size).toBe(1);
		h.tick();
		expect(h.renders).toBe(1);
		expect(component.render(160).map(Bun.stripANSI).join("\n")).toContain("next in 4m 59s");
		h.widget.update(h.ctx, [{ ...timer, pending: true }]);
		expect(h.mounts).toBe(1);
		expect(component.render(160).map(Bun.stripANSI).join("\n")).toContain("waiting for idle");
		h.widget.update(h.ctx, []);
		expect(h.factory).toBeUndefined();
		expect(h.wakes.size).toBe(0);
	});

	test("dispose and clear cancel even already-runnable refresh callbacks", () => {
		const h = harness();
		h.widget.update(h.ctx, [timer]);
		const component = h.mount();
		const stale = [...h.wakes][0]!;
		component.dispose?.();
		stale();
		expect(h.renders).toBe(0);
		expect(h.wakes.size).toBe(0);
		h.mount();
		expect(h.wakes.size).toBe(1);
		h.widget.clear();
		expect(h.wakes.size).toBe(0);
		h.widget.clear();
	});

	test("headless sessions never mount or schedule UI updates", () => {
		const h = harness();
		h.widget.update({ ...h.ctx, hasUI: false }, [timer]);
		expect(h.factory).toBeUndefined();
		expect(h.wakes.size).toBe(0);
	});
});
