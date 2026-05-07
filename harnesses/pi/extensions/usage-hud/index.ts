// @ts-nocheck
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type UsageHudConfig } from "./config";
import { renderFooter } from "./footer";
import {
	detectQuotaProvider,
	fetchQuotaForProvider,
	QUOTA_REFRESH_INTERVAL_MS,
	type QuotaSnapshot,
} from "./quota";
import { buildHudState, type HudState } from "./state";

export default function usageHudExtension(pi: ExtensionAPI) {
	let state: HudState | undefined;
	let config: UsageHudConfig = loadConfig();
	let requestRender: (() => void) | undefined;
	let quotaProvider: ReturnType<typeof detectQuotaProvider> = null;
	let quotaRefreshTimer: ReturnType<typeof setInterval> | undefined;
	const quotaCache = new Map<string, QuotaSnapshot>();
	let disposed = false;

	const syncState = (ctx: ExtensionContext): boolean => {
		if (disposed) return false;
		try {
			const quota = state?.quota ?? null;
			state = buildHudState(ctx, config, pi.getThinkingLevel());
			state.quota = quota;
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

	const stopQuotaRefresh = () => {
		if (!quotaRefreshTimer) return;
		clearInterval(quotaRefreshTimer);
		quotaRefreshTimer = undefined;
	};

	const applyQuotaSnapshot = (
		provider: ReturnType<typeof detectQuotaProvider>,
		snapshot: QuotaSnapshot,
	) => {
		if (disposed || quotaProvider !== provider || !state) return;
		const cacheKey = provider ?? "";
		const cached = quotaCache.get(cacheKey);
		if (
			snapshot.windows.length === 0 &&
			snapshot.error &&
			cached?.windows.length
		) {
			state.quota = cached;
			requestRender?.();
			return;
		}
		quotaCache.set(cacheKey, snapshot);
		state.quota = snapshot.windows.length > 0 ? snapshot : null;
		requestRender?.();
	};

	const fetchQuota = (provider: ReturnType<typeof detectQuotaProvider>) => {
		if (!provider) return;
		const cached = quotaCache.get(provider);
		if (state && cached?.windows.length) state.quota = cached;
		void fetchQuotaForProvider(provider)
			.then((snapshot) => applyQuotaSnapshot(provider, snapshot))
			.catch(() => {});
	};

	const startQuotaRefresh = (ctx: ExtensionContext) => {
		stopQuotaRefresh();
		if (!config.usageHud.quota.enabled) {
			quotaProvider = null;
			if (state) state.quota = null;
			return;
		}
		quotaProvider = detectQuotaProvider(ctx.model?.provider);
		if (!quotaProvider) {
			if (state) state.quota = null;
			requestRender?.();
			return;
		}
		fetchQuota(quotaProvider);
		quotaRefreshTimer = setInterval(
			() => fetchQuota(quotaProvider),
			config.usageHud.quota.refreshIntervalMs || QUOTA_REFRESH_INTERVAL_MS,
		);
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

		startQuotaRefresh(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		state = undefined;
		requestRender = undefined;
		stopQuotaRefresh();
	});

	pi.on("agent_start", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => refresh(ctx));
	pi.on("message_end", async (_event, ctx) => refresh(ctx));
	pi.on("tool_execution_end", async (_event, ctx) => refresh(ctx));
	pi.on("session_compact", async (_event, ctx) => refresh(ctx));
	pi.on("model_select", async (_event, ctx) => {
		if (!syncState(ctx)) return;
		startQuotaRefresh(ctx);
		requestRender?.();
	});
}
