import { describe, expect, test } from "bun:test";

import { installFocusCursor } from "./cursor-focus";

describe("focus cursor", () => {
	test("does not emit cursor-shape escape sequences", () => {
		const writes: string[] = [];
		const cleanup = installFocusCursor(
			{ exec: async () => ({}) } as never,
			{
				hasUI: true,
				ui: {
					onTerminalInput() {
						return () => {};
					},
				},
			} as never,
			{
				terminal: {
					write(sequence: string) {
						writes.push(sequence);
					},
				},
				setShowHardwareCursor() {},
				requestRender() {},
			} as never,
		);

		cleanup();

		expect(writes.some((sequence) => /\x1b\[[0-9] q/.test(sequence))).toBe(false);
	});
});
