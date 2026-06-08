import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildOwnCut, getLastCompactionStats, REASON_MESSAGES, VCC_COMPACT_INSTRUCTION } from "../hooks/before-compact";

const formatTokens = (n: number): string => {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
};

export const registerVccCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("vcc", {
		description: "Compact conversation with vcc structured summary",
		handler: async (_args, ctx) => {
			const ownCut = buildOwnCut(ctx.sessionManager.getBranch() as any[]);
			if (!ownCut.ok) {
				ctx.ui.notify(REASON_MESSAGES[ownCut.reason], "warning");
				return;
			}

			ctx.compact({
				customInstructions: VCC_COMPACT_INSTRUCTION,
				onComplete: () => {
					const stats = getLastCompactionStats();
					if (stats) {
						ctx.ui.notify(
							`vcc: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
							"info",
						);
					} else {
						ctx.ui.notify("Compacted with vcc", "info");
					}
				},
				onError: (err) => {
					if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
						ctx.ui.notify("Nothing to compact", "warning");
					} else {
						ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
					}
				},
			});
		},
	});
};
