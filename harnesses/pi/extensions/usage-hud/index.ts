import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type UsageHudConfig } from "./config";
import { renderFooter } from "./footer";
import { buildHudState, type HudState } from "./state";

export default function usageHudExtension(pi: ExtensionAPI) {
	let state: HudState | undefined;
	let config: UsageHudConfig = loadConfig();
	let requestRender: (() => void) | undefined;
	let disposed = false;

	const syncState = (ctx: ExtensionContext): boolean => {
		if (disposed) return false;
		try {
			state = buildHudState(ctx, config, pi.getThinkingLevel());
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("ctx is stale")) return false;
			throw error;
		}
	};

	const refresh = (ctx: ExtensionContext) => {
		if (!syncState(ctx)) return;
		requestRender?.();
	};

	const installFooter = (ctx: ExtensionContext) => {
		config = loadConfig();
		disposed = false;
		syncState(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => {
				refresh(ctx);
				tui.requestRender();
			});

			return {
				dispose() {
					unsubscribeBranch();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (!state) syncState(ctx);
					return renderFooter(
						state ?? buildHudState(ctx, config, pi.getThinkingLevel()),
						config,
						footerData.getGitBranch(),
						theme,
						width,
					);
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		state = undefined;
		requestRender = undefined;
	});

	pi.on("agent_start", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => refresh(ctx));
	pi.on("message_end", async (_event, ctx) => refresh(ctx));
	pi.on("tool_execution_end", async (_event, ctx) => refresh(ctx));
	pi.on("session_compact", async (_event, ctx) => refresh(ctx));
	pi.on("model_select", async (_event, ctx) => refresh(ctx));
}
