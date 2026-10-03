import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	ComponentStack,
	type MotionMount,
	sanitizeTuiFieldPreview,
	sharedMotionScheduler,
	tuiTheme,
} from "./libtui.ts";
import { ToolActivity, type TranscriptEntry } from "./libtui.ts";
import { ActivityTimings, formatActivityDuration } from "./activity-timing.ts";
import { handleNativeMouse, NativeMouseAdapter } from "./mouse.ts";

type ActivityEntry = Exclude<TranscriptEntry, { kind: "content" }>;

/** Use a provider's latest heading or paragraph; do not invent a reasoning summary. */
export function activitySummary(entry: ActivityEntry): string {
	if (entry.kind === "tool") return sanitizeTuiFieldPreview(entry.summary.replace(/^[^\p{L}\p{N}$]+/u, ""), 240);
	const tail = entry.summary.slice(-8_000);
	const headings = [...tail.matchAll(/(?:^|\n)\s*(?:\*\*([^\n]+?)\*\*|#{1,6}\s+([^\n]+))/gu)];
	const heading = headings.at(-1);
	const paragraph = tail
		.trim()
		.split(/\n\s*\n/u)
		.at(-1)
		?.split("\n")[0];
	return sanitizeTuiFieldPreview(heading?.[1] ?? heading?.[2] ?? paragraph ?? "Thinking", 240);
}

class ActivitySection extends ComponentStack {
	private readonly body = new ComponentStack();
	private readonly activity: ToolActivity;
	private entries: readonly ActivityEntry[] = [];
	private presentationVersions: number[] = [];
	private clock: MotionMount | undefined;
	private summary = "";
	private running = false;
	private failures = 0;

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly timings: ActivityTimings,
		private readonly now: () => number,
	) {
		super();
		this.activity = new ToolActivity({
			theme,
			requestRender,
			action: { render: (width) => this.renderHeader(width), invalidate() {} },
			view: { action: { verb: "Working", status: "running" } },
		});
		this.setChildren([new Spacer(1), this.activity]);
	}

	update(entries: readonly ActivityEntry[]): void {
		const versions = entries.map((entry) =>
			entry.component instanceof NativeMouseAdapter ? entry.component.getPresentationVersion() : 0,
		);
		if (
			entries.length === this.entries.length &&
			entries.every(
				(entry, index) => entry === this.entries[index] && versions[index] === this.presentationVersions[index],
			)
		)
			return;
		this.entries = entries;
		this.presentationVersions = versions;
		this.body.setChildren(entries.map((entry) => entry.component));
		// Keep the model's intent visible while tools run and after they finish.
		const latest =
			entries.filter((entry) => entry.kind === "thinking" && entry.summary.trim()).at(-1) ?? entries.at(-1)!;
		const running = entries.some((entry) => entry.running);
		const failures = entries.filter((entry) => entry.failed).length;
		this.summary = activitySummary(latest);
		this.running = running;
		this.failures = failures;
		if (running && !this.clock)
			this.clock = sharedMotionScheduler.mount({ requestRender: this.requestRender }, { cadenceMs: 1_000 });
		else if (!running) {
			this.clock?.dispose();
			this.clock = undefined;
		}
		this.activity.update({
			action: {
				verb: this.summary,
				status: failures ? "failed" : running ? "running" : "succeeded",
				marker: false,
			},
			running,
			payload: { kind: "component", preview: EMPTY, full: this.body },
		});
	}

	render(width: number): string[] {
		const rows = super.render(width);
		// Extend the underline through the empty columns, not just the disclosure text.
		if (rows[1]) {
			const colors = tuiTheme(this.theme);
			const padding = " ".repeat(Math.max(0, Math.floor(width) - visibleWidth(rows[1])));
			// The chevron closes its foreground; paint the remaining columns explicitly.
			const row = rows[1] + colors.fg("text.muted", padding);
			// Pi exposes only solid underlines; select dotted SGR styling at this terminal boundary.
			const underlined = this.theme.underline(row).replaceAll("\x1b[4m", "\x1b[4:4m");
			rows[1] = colors.fg("text.muted", underlined);
		}
		return rows;
	}

	private renderHeader(width: number): string[] {
		if (width <= 0) return [];
		const elapsed = this.timings.elapsed(this.entries, this.now());
		const duration = elapsed === undefined ? "" : ` for ${formatActivityDuration(elapsed)}`;
		const label = `  ${this.running ? "Working" : "Worked"}${duration} · ${this.theme.italic(this.summary)}`;
		const steps = `${this.entries.length} ${this.entries.length === 1 ? "step" : "steps"}`;
		const failed = this.failures ? ` · ${this.failures} failed` : "";
		return [truncateToWidth(`${label} · ${steps}${failed}`, width, "…")];
	}

	dispose(): void {
		this.clock?.dispose();
		this.activity.dispose();
	}
}

const EMPTY: Component = { render: () => [], invalidate() {} };

/** Fold consecutive tools/thinking, leaving assistant text and every other message in place. */
export class ActivityTranscript extends ComponentStack {
	private readonly nativeAdapters = new WeakMap<Component, NativeMouseAdapter>();
	private readonly adaptedEntries = new WeakMap<TranscriptEntry, TranscriptEntry>();

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return handleNativeMouse(this, event);
	}

	private adapt(entry: TranscriptEntry): TranscriptEntry {
		const cached = this.adaptedEntries.get(entry);
		if (cached) return cached;
		let component = this.nativeAdapters.get(entry.component);
		if (!component) {
			component = new NativeMouseAdapter(entry.component);
			this.nativeAdapters.set(entry.component, component);
		}
		const adapted = { ...entry, component };
		this.adaptedEntries.set(entry, adapted);
		return adapted;
	}
	private readonly sections = new Map<object, ActivitySection>();
	private completedBeforeTurn: Set<object> | undefined;

	constructor(
		private readonly entries: () => readonly TranscriptEntry[],
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly timings = new ActivityTimings(),
		private readonly now: () => number = Date.now,
	) {
		super();
	}

	beginTurn(includeExisting = false): void {
		// Retries and automatic continuations belong to the same visible run.
		this.completedBeforeTurn ??= new Set(includeExisting ? [] : this.entries().map((entry) => entry.key));
		this.requestRender();
	}

	finishTurn(): void {
		this.completedBeforeTurn = undefined;
		this.requestRender();
	}

	render(width: number): string[] {
		const children: Component[] = [];
		const retained = new Set<object>();
		let pending: ActivityEntry[] = [];
		const flush = () => {
			if (!pending.length) return;
			const key = pending[0]!.key;
			let section = this.sections.get(key);
			if (!section) {
				section = new ActivitySection(this.theme, this.requestRender, this.timings, this.now);
				this.sections.set(key, section);
			}
			section.update(pending);
			children.push(section);
			retained.add(key);
			pending = [];
		};
		for (const source of this.entries()) {
			const entry = this.adapt(source);
			if (entry.kind !== "content" && (!this.completedBeforeTurn || this.completedBeforeTurn.has(entry.key)))
				pending.push(entry);
			else {
				flush();
				children.push(entry.component);
			}
		}
		flush();
		for (const [key, section] of this.sections) {
			if (retained.has(key)) continue;
			section.dispose();
			this.sections.delete(key);
		}
		this.setChildren(children);
		return super.render(width);
	}

	dispose(): void {
		for (const section of this.sections.values()) section.dispose();
		this.sections.clear();
	}
}
