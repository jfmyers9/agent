import { Text } from "@earendil-works/pi-tui";

export const TURN_DURATION_ENTRY_TYPE = "tui-turn-duration";

export type TurnDurationEntry = Readonly<{
	startedAt: number;
	endedAt: number;
	durationMs: number;
}>;

type ThemeLike = {
	fg(role: string, text: string): string;
};

export class TurnDurationTimer {
	private startedAt: number | undefined;

	start(startedAt = Date.now()): void {
		this.startedAt = startedAt;
	}

	finish(endedAt = Date.now()): TurnDurationEntry | undefined {
		const startedAt = this.startedAt;
		this.startedAt = undefined;
		if (startedAt === undefined) return undefined;
		return createTurnDurationEntry(startedAt, endedAt);
	}

	reset(): void {
		this.startedAt = undefined;
	}
}

export function createTurnDurationEntry(startedAt: number, endedAt: number): TurnDurationEntry {
	return {
		startedAt,
		endedAt,
		durationMs: Math.max(0, endedAt - startedAt),
	};
}

export function isTurnDurationEntry(value: unknown): value is TurnDurationEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.startedAt === "number" &&
		Number.isFinite(entry.startedAt) &&
		typeof entry.endedAt === "number" &&
		Number.isFinite(entry.endedAt) &&
		typeof entry.durationMs === "number" &&
		Number.isFinite(entry.durationMs) &&
		entry.durationMs >= 0
	);
}

export function formatTurnDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(" ");
}

export function renderTurnDurationEntry(data: unknown, theme: ThemeLike): Text {
	const duration = isTurnDurationEntry(data) ? formatTurnDuration(data.durationMs) : "unknown";
	return new Text(`${theme.fg("dim", "took")} ${theme.fg("muted", duration)}`, 0, 0);
}
