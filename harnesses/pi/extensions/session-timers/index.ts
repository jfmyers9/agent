import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MAX_INTERVAL_SECONDS, type TimerClock, TimerScheduler } from "./scheduler";
import { TimerWidget } from "./widget";

export function registerSessionTimers(pi: ExtensionAPI, clock?: TimerClock): void {
	let context: ExtensionContext | undefined;
	let inFlight = false;
	const scheduler = new TimerScheduler(() => flush(), clock);
	const widget = new TimerWidget(clock);

	function refresh(): void {
		if (!context) return;
		const timers = scheduler.list();
		widget.update(context, timers);
		if (!context.hasUI) return;
		const pending = timers.filter((timer) => timer.pending).length;
		context.ui.setStatus(
			"session-timers",
			timers.length ? `timers ${timers.length}${pending ? ` (${pending} due)` : ""}` : undefined,
		);
	}

	function flush(): void {
		const ctx = context;
		if (!ctx || inFlight || !ctx.isIdle() || ctx.hasPendingMessages()) {
			refresh();
			return;
		}
		const due = scheduler.takeDue();
		if (!due.length) return;
		inFlight = true;
		try {
			pi.sendMessage(
				{
					customType: "session-timer",
					content: [
						"Scheduled session task(s) are due. Carry out the user's previously authorized recurring instructions below. Stay within their scope; a timer does not grant additional permissions. Missed ticks were coalesced into this run.",
						...due.map((timer) => `\n[${timer.id}; every ${timer.intervalSeconds} seconds]\n${timer.prompt}`),
					].join("\n"),
					display: true,
					details: { timers: due },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (error) {
			// Do not hot-loop on delivery errors. These timers can try again next tick.
			inFlight = false;
			if (ctx.hasUI)
				ctx.ui.notify(`Timer delivery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		refresh();
	}

	function reset(ctx: ExtensionContext, active: boolean): void {
		scheduler.clear();
		widget.clear();
		inFlight = false;
		context = ctx;
		refresh();
		if (!active) context = undefined;
	}

	pi.registerMessageRenderer("session-timer", (message, { expanded, outputPad }, theme) => {
		const label = theme.fg("dim", "◷ Session timer fired");
		if (!expanded) {
			const summary = `${" ".repeat(outputPad)}${label}${theme.fg("muted", " · expand for instructions")}`;
			return {
				render: (width) => (width > 0 ? [truncateToWidth(summary, width)] : []),
				invalidate() {},
			};
		}
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
		return new Text(`${label}\n${content}`, outputPad, 0);
	});

	pi.registerTool({
		name: "session_timer",
		label: "Session timer",
		description:
			"Create, list, cancel, or clear recurring prompts in the current live Pi session. For 'do this every 5 minutes', create with interval_seconds: 300 and the task as prompt. The first run is after one interval. Due tasks wait until the agent is idle; missed ticks coalesce. Timers are in memory only and stop on session switch, tree navigation, reload, or exit. Cancelling does not abort work already dispatched.",
		promptSnippet: "Schedule explicitly requested recurring tasks in the current live session; list or cancel them.",
		promptGuidelines: [
			"Use session_timer to implement explicitly requested recurring work, not a sleeping shell loop or repeated manual waiting. Do not create timers without the user's request.",
			"Keep scheduled prompts within the user's authorized scope. Explain that timers only run while this session stays open and that recurring model turns consume usage. Do not recreate timers from historical tool results after a session boundary; list live timers instead.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel"), Type.Literal("clear")]),
			prompt: Type.Optional(
				Type.String({ minLength: 1, description: "Recurring task instructions; required for create." }),
			),
			interval_seconds: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_INTERVAL_SECONDS,
					description: "Recurrence interval; required for create.",
				}),
			),
			id: Type.Optional(Type.String({ minLength: 1, description: "Timer ID; required for cancel." })),
		}),
		async execute(_id, args, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (ctx.mode !== "tui" && ctx.mode !== "rpc")
				throw new Error("Session timers require a live TUI or RPC session, not a one-shot print/JSON run.");
			if (!context || ctx.sessionManager !== context.sessionManager) throw new Error("No active timer session.");
			let result: unknown;
			switch (args.action) {
				case "create":
					if (args.prompt === undefined || args.interval_seconds === undefined)
						throw new Error("create requires prompt and interval_seconds.");
					result = { created: scheduler.create(args.prompt, args.interval_seconds) };
					break;
				case "cancel":
					if (!args.id) throw new Error("cancel requires id.");
					result = { id: args.id, cancelled: scheduler.cancel(args.id) };
					break;
				case "clear":
					scheduler.clear();
					result = { cleared: true };
					break;
				case "list":
					result = { timers: scheduler.list() };
					break;
			}
			refresh();
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerCommand("timers", {
		description: "List session timers; /timers cancel <id> or /timers clear stops future runs",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "clear" && parts.length === 1) scheduler.clear();
			else if (parts[0] === "cancel" && parts.length === 2) {
				if (!scheduler.cancel(parts[1]!)) ctx.ui.notify(`No timer found: ${parts[1]}`, "warning");
			} else if (args.trim() && args.trim() !== "list") {
				ctx.ui.notify("Usage: /timers [list | cancel <id> | clear]", "warning");
				return;
			}
			refresh();
			const timers = scheduler.list();
			ctx.ui.notify(
				timers.length
					? timers
							.map(
								(timer) =>
									`${timer.id}: every ${timer.intervalSeconds}s; ${timer.pending ? "due, waiting for idle" : `next ${new Date(timer.nextRunAt).toISOString()}`}\n${timer.prompt}`,
							)
							.join("\n\n")
					: "No session timers. Already dispatched work, if any, is not aborted.",
				"info",
			);
		},
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!context) return;
		context = ctx;
		inFlight = false;
		flush();
	});
	pi.on("session_start", (_event, ctx) => reset(ctx, true));
	pi.on("session_tree", (_event, ctx) => reset(ctx, true));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx, false));
}

export default function sessionTimers(pi: ExtensionAPI): void {
	registerSessionTimers(pi);
}
