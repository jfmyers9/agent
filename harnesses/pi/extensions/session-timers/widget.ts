import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type SessionTimer, systemClock, type TimerClock } from "./scheduler";

// Match the other UI extensions' runtime boundary: pinned LibTUI still exposes
// older Pi mouse/theme types. Only depend on the helpers exercised by our tests.
const libraryPath = import.meta.resolve("@luan.sh/pi-libtui");
const { icon, sanitizeTuiFieldPreview, tuiTheme } = (await import(libraryPath)) as {
	icon(name: "checkbox-off"): string;
	sanitizeTuiFieldPreview(text: string, limit: number): string;
	tuiTheme(theme: Theme): { fg(token: string, text: string): string };
};

export function formatTimerDuration(seconds: number): string {
	let remaining = Math.max(0, Math.ceil(seconds));
	const parts: string[] = [];
	for (const [unit, size] of [
		["d", 86_400],
		["h", 3_600],
		["m", 60],
		["s", 1],
	] as const) {
		const count = Math.floor(remaining / size);
		if (count) parts.push(`${count}${unit}`);
		remaining %= size;
	}
	return parts.join(" ") || "0s";
}

export function renderTimerWidget(timers: readonly SessionTimer[], theme: Theme, width: number, now: number): string[] {
	if (!timers.length || width <= 0) return [];
	const colors = tuiTheme(theme);
	const pending = timers.filter((timer) => timer.pending).length;
	const muted = (text: string) => colors.fg("text.muted", text);
	const visible = timers.slice(0, 11);
	return [
		`${colors.fg("accent", "◷ Timers")} ${muted(`· ${timers.length} scheduled${pending ? ` · ${pending} due` : ""} · /timers`)}`,
		...visible.map((timer, index) => {
			const prefix = index === timers.length - 1 ? "└─" : "├─";
			const marker = colors.fg(timer.pending ? "warning" : "text.muted", icon("checkbox-off"));
			const state = timer.pending
				? colors.fg("warning", "due · waiting for idle")
				: muted(`next in ${formatTimerDuration((timer.nextRunAt - now) / 1_000)}`);
			const preview = sanitizeTuiFieldPreview(timer.prompt, 300);
			return `${muted(prefix)} ${marker} ${colors.fg("text.primary", timer.id)} ${muted(`· every ${formatTimerDuration(timer.intervalSeconds)} ·`)} ${state} ${muted(`· ${preview}`)}`;
		}),
		...(visible.length < timers.length
			? [muted(`└─ +${timers.length - visible.length} more · /timers to list all`)]
			: []),
	].map((line) => truncateToWidth(line, width));
}

/** Keep one mounted panel and one UI-only wake, independent of scheduler dispatch. */
export class TimerWidget {
	private ui?: ExtensionContext["ui"];
	private timers: readonly SessionTimer[] = [];
	private tui?: TUI;
	private stopTick?: () => void;

	constructor(private clock: TimerClock = systemClock) {}

	update(ctx: ExtensionContext, timers: readonly SessionTimer[]): void {
		if (!ctx.hasUI || !timers.length) {
			this.clear();
			return;
		}
		if (this.ui !== ctx.ui) this.clear();
		this.timers = timers;
		if (this.ui) {
			this.tui?.requestRender();
			return;
		}
		this.ui = ctx.ui;
		ctx.ui.setWidget(
			"session-timers",
			(tui, theme) => {
				this.stopTick?.();
				this.tui = tui;
				let active = true;
				let cancel: (() => void) | undefined;
				const tick = () => {
					if (!active) return;
					tui.requestRender();
					cancel = this.clock.schedule(tick, 1_000);
				};
				// Only mounted TUI panels need countdown wakes (not headless/RPC clients).
				cancel = this.clock.schedule(tick, 1_000);
				const stop = () => {
					active = false;
					cancel?.();
					if (this.stopTick === stop) {
						this.stopTick = undefined;
						this.tui = undefined;
					}
				};
				this.stopTick = stop;
				return {
					render: (width) => renderTimerWidget(this.timers, theme, width, this.clock.now()),
					invalidate() {},
					dispose: stop,
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	clear(): void {
		this.stopTick?.();
		this.ui?.setWidget("session-timers", undefined);
		this.ui = undefined;
		this.timers = [];
	}
}
