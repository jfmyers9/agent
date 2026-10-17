import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FILE_MUTATION_EVENT, type ToolFileMutation } from "../shared/file-mutations.js";
import { readDiff } from "./git.js";
import { DiffView } from "./view.js";
import { DiffPane } from "./pane.js";
import { TurnDiff } from "./turn.js";

export default function diffProd(pi: ExtensionAPI) {
	let pane: DiffPane | undefined;
	let release: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;
	let scope: "turn" | "repo" = "turn";
	let started = false;
	const calls = new Set<string>();
	const turn = new TurnDiff();
	const title = () =>
		scope === "turn" ? "Diff · This turn · edit/write/patch" : "Production diff · Repository · tracked";
	const read = (cwd: string) => (scope === "turn" ? Promise.resolve(turn.read(cwd)) : readDiff(pi, cwd));
	const reset = () => {
		turn.reset();
		calls.clear();
		if (scope === "turn") pane?.clear();
	};
	pi.on("session_start", (_event, ctx) => {
		release?.();
		unsubscribe?.();
		scope = "turn";
		started = false;
		reset();
		unsubscribe = pi.events.on(FILE_MUTATION_EVENT, (data) => {
			const mutation = data as ToolFileMutation;
			if (!mutation || !calls.has(mutation.toolCallId)) return;
			turn.record(mutation);
			if (scope === "turn") void pane?.refresh();
		});
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget("pi-diff-prod.host", (tui) => {
			release?.();
			const mounted = new DiffPane(
				() => read(ctx.cwd),
				() => ({
					columns: tui.terminal.columns,
					rows: tui.terminal.rows,
					fullscreen: tui.mode === "fullscreen",
				}),
				undefined,
				title,
			);
			pane = mounted;
			// Poll Git only in explicit repository mode. Turn diffs never read the
			// working tree, so other sessions cannot change the captured preview.
			const timer = setInterval(() => {
				mounted.syncLayout();
				if (scope === "repo") void mounted.refresh();
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
	// A consumed user message (including steering/follow-up) is the boundary.
	// Model turns, retries, compaction and automatic continuations are not.
	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		reset();
		started = true;
	});
	pi.on("session_tree", () => {
		reset();
		started = false;
	});
	pi.on("tool_execution_start", (event) => {
		if (started) calls.add(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		calls.delete(event.toolCallId);
		refresh();
	});
	pi.on("turn_end", refresh);
	pi.on("agent_settled", refresh);
	pi.on("session_shutdown", (_event, ctx) => {
		release?.();
		unsubscribe?.();
		reset();
		started = false;
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("pi-diff-prod.host", undefined);
	});
	pi.registerShortcut("ctrl+alt+d", {
		description: "Focus production diff pane or return to editor",
		handler: async (ctx) => {
			if (!pane?.focus()) ctx.ui.notify("No visible diff pane. Use /diff-prod for the overlay.", "info");
		},
	});
	pi.registerCommand("diff-prod", {
		description: "Turn-scoped diff overlay; turn/repo selects scope, on/off/toggle/focus controls the pane",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diff-prod requires an interactive Pi session.", "warning");
				return;
			}
			const action = args.trim();
			if (action === "turn" || action === "repo") {
				scope = action;
				pane?.clear();
				refresh();
				ctx.ui.notify(
					scope === "turn"
						? "Diff scope: This turn (edit/write/apply_patch only; shell/external edits are not captured)."
						: "Diff scope: Repository (staged + unstaged tracked production files against HEAD).",
					"info",
				);
				return;
			}
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
				ctx.ui.notify(
					"Usage: /diff-prod [turn|repo|on|off|toggle|focus] — repository exclusions: .pi/diff-prod.json",
					"info",
				);
				return;
			}
			try {
				const diff = await read(ctx.cwd);
				if (!diff) {
					ctx.ui.notify(
						scope === "turn"
							? "No captured changes this turn. Shell/external edits are not captured; use /diff-prod repo for the working tree."
							: "No production changes in tracked files (untracked files are not included).",
						"info",
					);
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
							undefined,
							title(),
						),
					{ overlay: true, overlayOptions: { width: "100%", anchor: "center" } },
				);
			} catch (error) {
				ctx.ui.notify(`Production diff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
