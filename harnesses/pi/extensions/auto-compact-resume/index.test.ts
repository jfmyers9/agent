import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoCompactResumeExtension, { needsCompaction } from "./index";

describe("auto compact and resume", () => {
	test("compacts tool loops at 85 percent, then resumes", async () => {
		let turnEnd: ((event: any, ctx: any) => void) | undefined;
		let compactOptions: any;
		const messages: any[] = [];
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => void) {
				if (event === "turn_end") turnEnd = handler;
			},
			sendMessage(message: any, options: any) {
				messages.push({ message, options });
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: 235_000, contextWindow: 272_000, percent: 86 }),
			hasPendingMessages: () => false,
			hasUI: false,
			compact(options: any) {
				compactOptions = options;
			},
		};

		autoCompactResumeExtension(pi);
		turnEnd?.({ message: { content: [{ type: "toolCall" }] } }, ctx);
		expect(compactOptions).toBeDefined();

		compactOptions.onComplete();
		expect(messages).toEqual([
			{
				message: {
					customType: "auto-compact-resume",
					content: "Continue the original request from the compacted context.",
					display: false,
				},
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	test("leaves completed and low-context turns alone", () => {
		expect(needsCompaction([{ type: "text" }], 235_000, 272_000)).toBe(false);
		expect(needsCompaction([{ type: "toolCall" }], 224_000, 272_000)).toBe(false);
	});

	test("reports the real compaction error even when ctx has gone stale", () => {
		let turnEnd: ((event: any, ctx: any) => void) | undefined;
		let compactOptions: any;
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => void) {
				if (event === "turn_end") turnEnd = handler;
			},
			sendMessage() {
				throw new Error("sendMessage should not run");
			},
		} as unknown as ExtensionAPI;
		const stale = () => {
			throw new Error("This extension ctx is stale after session replacement or reload");
		};
		const ctx = {
			getContextUsage: () => ({ tokens: 235_000, contextWindow: 272_000, percent: 86 }),
			get hasUI(): boolean {
				return stale();
			},
			hasPendingMessages: stale,
			compact(options: any) {
				compactOptions = options;
			},
		};
		const logged: string[] = [];
		const errorSpy = spyOn(console, "error").mockImplementation((message: string) => {
			logged.push(message);
		});
		try {
			autoCompactResumeExtension(pi);
			turnEnd?.({ message: { content: [{ type: "toolCall" }] } }, ctx);

			expect(() => compactOptions.onError(new Error("summarization request timed out"))).not.toThrow();
			expect(() => compactOptions.onComplete()).not.toThrow();
		} finally {
			errorSpy.mockRestore();
		}
		expect(logged[0]).toBe("[auto-compact-resume] Auto-compaction failed: summarization request timed out");
		expect(logged.some((line) => line.includes("Could not report the compaction failure"))).toBe(true);
		expect(logged.some((line) => line.includes("could not resume"))).toBe(true);

		// A later turn can compact again: neither callback left the extension stuck.
		compactOptions = undefined;
		turnEnd?.(
			{ message: { content: [{ type: "toolCall" }] } },
			{
				getContextUsage: ctx.getContextUsage,
				compact(options: any) {
					compactOptions = options;
				},
			},
		);
		expect(compactOptions).toBeDefined();
	});
});
