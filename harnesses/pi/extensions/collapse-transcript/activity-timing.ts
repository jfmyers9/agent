import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptEntry } from "./libtui.ts";

interface Interval {
	start: number;
	end?: number;
}

/** Reconstruct wall time from the active branch, including after reload or resume. */
export class ActivityTimings {
	private readonly thoughts = new Map<number, Interval>();
	private readonly tools = new Map<string, Interval>();

	load(branch: readonly SessionEntry[]): void {
		this.thoughts.clear();
		this.tools.clear();
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") {
				const start = message.timestamp;
				const end = Date.parse(entry.timestamp);
				if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
				this.thoughts.set(start, { start, end });
				// Pi persists tool calls when the assistant finishes, before execution.
				for (const part of message.content) {
					if (part.type === "toolCall") this.tools.set(part.id, { start: end });
				}
			} else if (message.role === "toolResult") {
				const interval = this.tools.get(message.toolCallId);
				if (interval && Number.isFinite(message.timestamp)) interval.end = message.timestamp;
			}
		}
	}

	elapsed(entries: readonly TranscriptEntry[], now: number): number | undefined {
		let start = Number.POSITIVE_INFINITY;
		let end = Number.NEGATIVE_INFINITY;
		for (const entry of entries) {
			const interval =
				entry.kind === "thinking" && entry.timestamp !== undefined
					? (this.thoughts.get(entry.timestamp) ?? (entry.running ? { start: entry.timestamp } : undefined))
					: entry.kind === "tool" && entry.toolCallId
						? this.tools.get(entry.toolCallId)
						: undefined;
			if (!interval) continue;
			const finished = entry.kind !== "content" && entry.running ? now : interval.end;
			if (finished === undefined) continue;
			start = Math.min(start, interval.start);
			end = Math.max(end, finished);
		}
		return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
	}
}

export function formatActivityDuration(milliseconds: number): string {
	const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
