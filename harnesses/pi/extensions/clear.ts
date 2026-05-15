import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function clearExtension(pi: ExtensionAPI) {
	async function clearSession(ctx: ExtensionCommandContext) {
		try {
			if (!ctx.isIdle()) await ctx.waitForIdle();
			const result = await ctx.newSession();
			if (result.cancelled) ctx.ui.notify("Clear cancelled by extension.", "warning");
		} catch (error) {
			ctx.ui.notify(`Clear failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	pi.registerCommand("clear", {
		description: "Start a fresh session, waiting for the current turn first if needed",
		handler: async (_args, ctx) => clearSession(ctx),
	});

	pi.registerShortcut("ctrl+shift+l", {
		description: "Clear session and start fresh",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			pi.sendUserMessage("/clear", ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}
