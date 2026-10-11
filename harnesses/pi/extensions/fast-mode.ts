import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FAST_MODE_STATUS = "openai-fast-mode";
type Route = "openai" | "codex";
type ModelRoute = { provider: string; api: string; id: string; baseUrl: string };

/** Limit priority requests to native first-party GPT Responses selections. */
export function fastRoute(model: ModelRoute | undefined): Route | undefined {
	if (!model?.id.startsWith("gpt-")) return undefined;
	let url: URL;
	try {
		url = new URL(model.baseUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.port || url.username || url.password) return undefined;
	if (
		model.provider === "openai" &&
		model.api === "openai-responses" &&
		url.hostname === "api.openai.com" &&
		url.pathname.replace(/\/$/, "") === "/v1"
	)
		return "openai";
	if (
		(model.provider === "openai-codex" || model.provider === "openai") &&
		model.api === "openai-codex-responses" &&
		url.hostname === "chatgpt.com" &&
		["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(url.pathname.replace(/\/$/, ""))
	)
		return "codex";
	return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default function fastMode(pi: ExtensionAPI): void {
	let enabled = false;
	const updateStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(FAST_MODE_STATUS, enabled && fastRoute(ctx.model) ? "fast" : undefined);
	};
	const reset = (ctx: ExtensionContext) => {
		// Priority must be explicitly opted into again, never restored from history.
		enabled = false;
		updateStatus(ctx);
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		reset(ctx);
	});
	pi.on("before_provider_request", (event, ctx) => {
		updateStatus(ctx);
		if (!enabled || !fastRoute(ctx.model) || !record(event.payload)) return;
		// Guard requests routed to a different model than the current selection.
		if (event.payload.model !== ctx.model?.id) return;
		return { ...event.payload, service_tier: "priority" };
	});
	// Native adapters request priority with the body field alone. Do not rewrite
	// auth/originator headers: Pi's header hook has no per-request model identity.
	function setEnabled(value: boolean, ctx: ExtensionContext): void {
		if (value && !fastRoute(ctx.model)) {
			ctx.ui.notify(
				"Fast mode supports first-party OpenAI/Codex GPT Responses routes, not this model or endpoint.",
				"warning",
			);
			return;
		}
		enabled = value;
		updateStatus(ctx);
		ctx.ui.notify(
			enabled
				? "Fast mode on: priority requested for subsequent GPT calls. Higher cost/quota use may apply; availability depends on OpenAI."
				: "Fast mode off: no priority override on subsequent calls.",
			"info",
		);
	}
	pi.registerCommand("fast", {
		description: "Toggle session-only OpenAI/Codex priority routing: /fast [on|off|toggle|status]",
		getArgumentCompletions: (prefix) =>
			["on", "off", "toggle", "status"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(
					`Fast mode ${enabled ? "on" : "off"}${!fastRoute(ctx.model) ? " (inactive on this model/endpoint)" : enabled ? " — priority requested, not guaranteed" : ""}. /fast toggles for this session.`,
					"info",
				);
			} else if (!action || ["on", "off", "toggle"].includes(action))
				setEnabled(!action || action === "toggle" ? !enabled : action === "on", ctx);
			else ctx.ui.notify("Usage: /fast [on|off|toggle|status]", "warning");
		},
	});
}
