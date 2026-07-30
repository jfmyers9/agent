import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoCompactResumeExtension, { needsCompaction } from "./index";

describe("auto compact and resume", () => {
	test("compacts tool loops using the model output reserve, then resumes", async () => {
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
			model: { maxTokens: 128_000 },
			getContextUsage: () => ({ tokens: 150_000, contextWindow: 272_000, percent: 55 }),
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
		expect(needsCompaction([{ type: "text" }], 200_000, 272_000, 128_000)).toBe(false);
		expect(needsCompaction([{ type: "toolCall" }], 140_000, 272_000, 128_000)).toBe(false);
	});
});
