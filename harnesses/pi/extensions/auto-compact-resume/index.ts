import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMPACT_AT_PERCENT = 85;
const MESSAGE_TYPE = "auto-compact-resume";
export const AUTO_COMPACT_STOP_MESSAGE =
	"End the current response immediately. Output no text and do not call tools. Context compaction will run, then the task will resume.";

export function needsCompaction(
	content: readonly { type: string }[],
	tokens: number | null,
	contextWindow: number,
): boolean {
	return (
		content.some((part) => part.type === "toolCall") &&
		tokens !== null &&
		tokens / contextWindow >= COMPACT_AT_PERCENT / 100
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Compaction callbacks can run after the session that owned ctx was replaced, e.g. once a print-mode
// run has ended. Reading a stale ctx then throws, which used to replace the real compaction error
// with "ctx is stale". Always log the original error and never let a callback throw.
function logError(message: string): void {
	console.error(`[${MESSAGE_TYPE}] ${message}`);
}

export default function autoCompactResumeExtension(pi: ExtensionAPI) {
	let compacting = false;

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		if (compacting) return;
		// ctx.compact() aborts the running turn before summarizing. Headless (print/JSON) runs end once
		// their prompt settles, so that abort exits the process and tears the summarization down. Pi's
		// own threshold compaction runs inline between turns without aborting, so leave headless runs to it.
		if (!ctx.hasUI) return;

		const usage = ctx.getContextUsage();
		const content = "content" in event.message && Array.isArray(event.message.content) ? event.message.content : [];
		if (!usage || !needsCompaction(content, usage.tokens, usage.contextWindow)) {
			return;
		}

		compacting = true;
		ctx.compact({
			onComplete: () => {
				compacting = false;
				try {
					if (ctx.hasPendingMessages()) return;
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE,
							content: "Continue the original request from the compacted context.",
							display: false,
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				} catch (error) {
					logError(`Compaction finished but the task could not resume: ${errorMessage(error)}`);
				}
			},
			onError: (error) => {
				compacting = false;
				const message = `Auto-compaction failed: ${errorMessage(error)}`;
				logError(message);
				try {
					if (ctx.hasUI) ctx.ui.notify(message, "error");
				} catch (notifyError) {
					logError(`Could not report the compaction failure: ${errorMessage(notifyError)}`);
				}
			},
		});
	});
}
