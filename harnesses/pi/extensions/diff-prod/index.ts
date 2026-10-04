import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readDiff } from "./git.js";
import { DiffView } from "./view.js";
import { DiffPane } from "./pane.js";

export default function diffProd(pi: ExtensionAPI) {
	let pane: DiffPane | undefined;
	let release: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		release?.();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget("pi-diff-prod.host", (tui) => {
			release?.();
			const mounted = new DiffPane(
				() => readDiff(pi, ctx.cwd),
				() => ({
					columns: tui.terminal.columns,
					rows: tui.terminal.rows,
					fullscreen: tui.mode === "fullscreen",
				}),
			);
			pane = mounted;
			// Pi's user_bash event runs before shell execution. Polling also catches
			// !! commands, edits in another terminal, and changes outside Pi tools.
			const timer = setInterval(() => {
				mounted.syncLayout();
				void mounted.refresh();
			}, 3000);
			timer.unref();
			void mounted.refresh();
			let disposed = false;
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				clearInterval(timer);
				mounted.dispose();
				if (pane === mounted) pane = undefined;
				if (release === dispose) release = undefined;
			};
			release = dispose;
			return {
				render: () => {
					// Do not change the layout tree during its render traversal.
					queueMicrotask(() => mounted.syncLayout());
					return [];
				},
				invalidate() {},
				dispose,
			};
		});
	});
	const refresh = () => {
		void pane?.refresh();
	};
	pi.on("tool_execution_end", refresh);
	pi.on("turn_end", refresh);
	pi.on("agent_settled", refresh);
	pi.on("session_shutdown", (_event, ctx) => {
		release?.();
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("pi-diff-prod.host", undefined);
	});
	pi.registerShortcut("ctrl+alt+d", {
		description: "Focus production diff pane or return to editor",
		handler: async (ctx) => {
			if (!pane?.focus()) ctx.ui.notify("No visible diff pane. Use /diff-prod for the overlay.", "info");
		},
	});
	pi.registerCommand("diff-prod", {
		description: "Production diff overlay; on/off/toggle/focus controls the automatic right pane",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diff-prod requires an interactive Pi session.", "warning");
				return;
			}
			const action = args.trim();
			if (["on", "off", "toggle", "focus"].includes(action)) {
				if (!pane) {
					ctx.ui.notify(
						"The diff pane requires an interactive fullscreen terminal. Use /diff-prod for the overlay.",
						"info",
					);
					return;
				}
				if (action === "focus") {
					if (!pane.focus())
						ctx.ui.notify("No visible diff pane (requires changes and at least 120 columns in fullscreen).", "info");
				} else {
					const enabled = action === "toggle" ? pane.toggle() : action === "on";
					if (action !== "toggle") pane.setEnabled(enabled);
					ctx.ui.notify(`Automatic production diff pane ${enabled ? "on" : "off"}.`, "info");
				}
				return;
			}
			if (action) {
				ctx.ui.notify("Usage: /diff-prod [on|off|toggle|focus] — exclusions: .pi/diff-prod.json", "info");
				return;
			}
			try {
				const diff = await readDiff(pi, ctx.cwd);
				if (!diff) {
					ctx.ui.notify("No production changes in tracked files (untracked files are not included).", "info");
					return;
				}
				await ctx.ui.custom<void>(
					(tui, theme, _kb, done) =>
						new DiffView(
							diff,
							theme,
							() => tui.terminal.rows,
							() => tui.requestRender(),
							done,
						),
					{ overlay: true, overlayOptions: { width: "100%", anchor: "center" } },
				);
			} catch (error) {
				ctx.ui.notify(`Production diff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
