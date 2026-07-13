import { describe, expect, test } from "bun:test";
import {
	createTurnDurationEntry,
	formatTurnDuration,
	isTurnDurationEntry,
	renderTurnDurationEntry,
	TurnDurationTimer,
} from "./turn-duration";

describe("TurnDurationTimer", () => {
	test("records a completed agent run once", () => {
		const timer = new TurnDurationTimer();
		timer.start(1_000);

		expect(timer.finish(63_500)).toEqual({
			startedAt: 1_000,
			endedAt: 63_500,
			durationMs: 62_500,
		});
		expect(timer.finish(64_000)).toBeUndefined();
	});

	test("does not report a negative duration when the clock moves backward", () => {
		expect(createTurnDurationEntry(5_000, 4_000)).toEqual({
			startedAt: 5_000,
			endedAt: 4_000,
			durationMs: 0,
		});
	});
});

describe("formatTurnDuration", () => {
	test.each([
		[0, "0s"],
		[59_999, "59s"],
		[60_000, "1m 0s"],
		[3_661_000, "1h 1m 1s"],
	])("formats %d milliseconds as %s", (durationMs, expected) => {
		expect(formatTurnDuration(durationMs)).toBe(expected);
	});
});

describe("isTurnDurationEntry", () => {
	test("accepts complete persisted duration data", () => {
		expect(isTurnDurationEntry(createTurnDurationEntry(1_000, 2_000))).toBe(true);
	});

	test("rejects malformed persisted duration data", () => {
		expect(isTurnDurationEntry({ durationMs: 1_000 })).toBe(false);
		expect(isTurnDurationEntry({ startedAt: 0, endedAt: 1_000, durationMs: -1 })).toBe(false);
	});
});

describe("renderTurnDurationEntry", () => {
	test("renders the persisted duration as a compact completion summary", () => {
		const theme = { fg: (_role: string, text: string) => text };
		const entry = createTurnDurationEntry(1_000, 63_500);

		expect(
			renderTurnDurationEntry(entry, theme)
				.render(80)
				.map((line) => line.trimEnd()),
		).toEqual(["took 1m 2s"]);
	});
});
