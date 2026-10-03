import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mountTranscriptProjection } from "./libtui.ts";
import { ActivityTimings } from "./activity-timing.ts";
import { ActivityTranscript } from "./activity-transcript.ts";

export default function transcriptExtension(pi: ExtensionAPI): void {
	let unmount: (() => void) | undefined;
	let transcript: ActivityTranscript | undefined;
	let running = false;
	pi.on("agent_start", () => {
		running = true;
		transcript?.beginTurn();
	});
	pi.on("agent_settled", () => {
		running = false;
		transcript?.finishTurn();
	});
	pi.on("session_start", (_event, ctx) => {
		unmount?.();
		unmount = undefined;
		transcript = undefined;
		running = !ctx.isIdle();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget("pi-collapse-transcript.host", (tui, theme) => {
			unmount?.();
			const timings = new ActivityTimings();
			let previousLeaf: string | null | undefined;
			const detach = mountTranscriptProjection(tui, (entries) => {
				transcript = new ActivityTranscript(
					() => {
						const leaf = ctx.sessionManager.getLeafId();
						if (leaf !== previousLeaf) {
							timings.load(ctx.sessionManager.getBranch());
							previousLeaf = leaf;
						}
						return entries();
					},
					theme,
					() => tui.requestRender(),
					timings,
				);
				// A remount loses the native entry identities. Fail visible until settlement
				// rather than folding already-completed steps from the still-active run.
				if (running) transcript.beginTurn(true);
				return transcript;
			});
			const mounted = transcript;
			let disposed = false;
			const release = () => {
				if (disposed) return;
				disposed = true;
				detach?.();
				if (transcript === mounted) transcript = undefined;
				if (unmount === release) unmount = undefined;
			};
			unmount = release;
			return {
				render: () => [],
				invalidate() {},
				dispose: () => {
					release?.();
					if (unmount === release) unmount = undefined;
				},
			};
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		running = false;
		unmount?.();
		unmount = undefined;
		transcript = undefined;
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("pi-collapse-transcript.host", undefined);
	});
}
