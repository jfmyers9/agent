import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { runCommand } from "../shared/ct-runner";
import { terminalRows } from "../shared/terminal";
import { ensureConfigExists, loadConfig, type PolishedTuiConfig, saveConfig } from "./config";
import { installFocusCursor } from "./cursor-focus";
import {
	advanceWorkingAnimationFrame,
	type EditorSessionIdentity,
	installEditorComposition,
	setCachedSkillNames,
	setEditorChromeProvider,
	setEditorSessionIdentityProvider,
	setWorkingAnimationState,
} from "./editor";
import {
	emptyFooterState,
	estimateContextBreakdown,
	type FooterRenderState,
	renderEditorContextStatus,
	renderEditorTopStatus,
	scaleContextSegmentsToUsage,
	scaleContextSlicesToUsage,
} from "./footer";
import { readGitStatus } from "./git";
import { readRuntimeInfo } from "./runtime";
import { detectUsageProvider, fetchUsageForProvider, USAGE_REFRESH_INTERVAL, type UsageSnapshot } from "./usage";

type UsageTotals = { input: number; output: number; cost: number };

type UsageBarCache = {
	key: string;
	lines: string[];
};

const CONTEXT_PULSE_INTERVAL_MS = 320;
const CONTEXT_PULSE_DURATION_MS = 1200;
const MOSAIC_IDENTITY_COLORS = ["f38ba8", "fab387", "f9e2af", "eba0ac", "e78284", "ff9e64", "ffc777", "ff757f"];

function cleanIdentityPart(value: string | undefined): string | undefined {
	const text = value
		?.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function readMosaicIdentityEnv(): EditorSessionIdentity | undefined {
	const label = cleanIdentityPart(process.env.MOSAIC_AGENT_LABEL);
	const name = cleanIdentityPart(process.env.MOSAIC_AGENT_NAME);
	const color = mosaicIdentityColor(label) ?? cleanIdentityPart(process.env.MOSAIC_AGENT_COLOR);
	if (!label && !name && !color) return undefined;
	return { label, name, color };
}

function mosaicIdentityColor(label: string | undefined): string | undefined {
	const match = label?.match(/^A(\d+)$/);
	if (!match) return undefined;
	const index = Number(match[1]);
	if (!Number.isFinite(index) || index <= 0) return undefined;
	return MOSAIC_IDENTITY_COLORS[(index - 1) % MOSAIC_IDENTITY_COLORS.length];
}

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
	};
	return known[provider] ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function providerColor(providerLabel: string): string | undefined {
	switch (providerLabel) {
		case "Anthropic":
			return "d87b4a";
		case "OpenAI":
			return "74c7ec";
		case "Copilot":
			return "cba6f7";
		case "Google":
			return "a6e3a1";
		case "MiniMax":
		case "MiniMax CN":
			return "fab387";
		default:
			return undefined;
	}
}

function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}
	return { input, output, cost };
}

function truncateUsageLine(line: string, width: number): string {
	return line ? truncateToWidth(line, Math.max(1, width), "") : "";
}

export default function (pi: ExtensionAPI) {
	const state: FooterRenderState = emptyFooterState();
	const usageCache = new Map<string, UsageSnapshot>();

	let currentConfig: PolishedTuiConfig = loadConfig();
	let requestFooterRender: (() => void) | undefined;
	let projectRefreshInFlight = false;
	let projectRefreshPending = false;

	let activeProvider: string | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let usageBarCache: UsageBarCache | null = null;
	let usageBarPendingKey: string | null = null;
	let usageBarsVisible = currentConfig.usageBars.visible;
	let contextPulseTimer: ReturnType<typeof setInterval> | null = null;
	let workingAnimationTimer: ReturnType<typeof setInterval> | null = null;
	const contextPulseDeadlines = new Map<number, number>();
	let disposed = false;
	let uiGeneration = 0;
	let unsubscribeSkillfulCache: (() => void) | undefined;
	let editorSessionIdentity: EditorSessionIdentity | undefined;

	const isStaleCtxError = (error: unknown) =>
		(error instanceof Error ? error.message : String(error)).includes("ctx is stale");
	const isCurrent = (generation: number) => !disposed && generation === uiGeneration;

	const refresh = () => {
		if (!disposed) requestFooterRender?.();
	};

	const stopContextPulse = () => {
		if (contextPulseTimer) {
			clearInterval(contextPulseTimer);
			contextPulseTimer = null;
		}
		state.contextPulseSliceIndexes = [];
		state.contextPulseFrame = 0;
		contextPulseDeadlines.clear();
	};

	const activePulseIndexes = () => {
		const now = Date.now();
		for (const [index, deadline] of contextPulseDeadlines) {
			if (deadline <= now || index >= state.contextSlices.length) contextPulseDeadlines.delete(index);
		}
		return [...contextPulseDeadlines.keys()].sort((a: number, b: number) => a - b);
	};

	const pulseContextSliceIndexes = (indexes: readonly number[]) => {
		if (indexes.length === 0) return;
		const deadline = Date.now() + CONTEXT_PULSE_DURATION_MS;
		for (const index of indexes) {
			if (index >= 0 && index < state.contextSlices.length) contextPulseDeadlines.set(index, deadline);
		}
		state.contextPulseSliceIndexes = activePulseIndexes();
		if (contextPulseTimer) return;

		contextPulseTimer = setInterval(() => {
			if (disposed) {
				stopContextPulse();
				refresh();
				return;
			}
			state.contextPulseSliceIndexes = activePulseIndexes();
			if (state.contextPulseSliceIndexes.length === 0) {
				stopContextPulse();
				refresh();
				return;
			}
			state.contextPulseFrame++;
			refresh();
		}, CONTEXT_PULSE_INTERVAL_MS);
	};

	const pulseLastContextSlicesForMessage = (message: unknown) => {
		const pulseSliceCount = estimateContextBreakdown([message], "").slices.length;
		if (pulseSliceCount <= 0) return;
		const start = Math.max(0, state.contextSlices.length - pulseSliceCount);
		pulseContextSliceIndexes(Array.from({ length: state.contextSlices.length - start }, (_, index) => start + index));
	};

	const isCompactTerminal = () => {
		const rows = terminalRows();
		return rows !== undefined && rows < currentConfig.compact.minTerminalRows;
	};

	const usageBarKey = (width: number): string =>
		JSON.stringify({
			width,
			provider: state.providerLabel,
			fetchedAt: state.usage?.fetchedAt ?? 0,
			windows: state.usage?.windows ?? [],
		});

	const ensureUsageBarLines = (width: number) => {
		const key = usageBarKey(width);
		if (usageBarCache?.key === key) {
			state.usageLines = usageBarCache.lines;
			return;
		}

		if (!state.usage?.windows.length) {
			state.usageLines = undefined;
			usageBarCache = null;
			usageBarPendingKey = null;
			return;
		}

		if (usageBarPendingKey === key) return;
		usageBarPendingKey = key;

		const request = {
			provider_label: state.providerLabel,
			provider_color: providerColor(state.providerLabel),
			windows: state.usage.windows.map((w) => ({
				label: w.label,
				used_percent: w.usedPercent,
				window_secs: w.windowSecs,
				reset_secs: w.resetSecs,
			})),
			width,
		};

		void runCommand(
			"ct",
			["tui", "usage-bar", "--width", String(width)],
			process.cwd(),
			undefined,
			JSON.stringify(request),
		)
			.then((result) => {
				if (usageBarPendingKey !== key) return;
				usageBarPendingKey = null;
				const lines = result.stdout.split(/\r?\n/).filter(Boolean);
				usageBarCache = { key, lines };
				state.usageLines = lines;
				refresh();
			})
			.catch(() => {
				if (usageBarPendingKey !== key) return;
				usageBarPendingKey = null;
				usageBarCache = null;
				state.usageLines = undefined;
				refresh();
			});
	};

	const renderEditorTopChrome = (
		width: number,
		theme: Parameters<typeof renderEditorContextStatus>[1],
		cwd: string,
	) => {
		const safeWidth = Math.max(1, width);
		let usageLine = "";
		if (usageBarsVisible) {
			const usageWidth = Math.max(20, Math.min(56, Math.floor(safeWidth * 0.36)));
			ensureUsageBarLines(usageWidth);
			usageLine = truncateUsageLine(state.usageLines?.[0] ?? "", usageWidth);
		}

		const gapWidth = usageLine ? 2 : 0;
		let statusWidth = safeWidth - visibleWidth(usageLine) - gapWidth;
		if (statusWidth < 24) {
			usageLine = "";
			statusWidth = safeWidth;
		}
		const topStatus = renderEditorTopStatus(state, currentConfig, cwd, theme, statusWidth);
		return [usageLine, topStatus].filter(Boolean).join("  ");
	};

	const renderEditorBottomStatus = (width: number, theme: Parameters<typeof renderEditorContextStatus>[1]) => {
		const safeWidth = Math.max(1, width);
		const contextWidth = Math.min(Math.floor(safeWidth * 0.5), safeWidth);
		const parts: string[] = [];
		if (contextWidth >= 12) parts.push(renderEditorContextStatus(state, theme, contextWidth));
		return parts.join("  ");
	};

	const syncState = (ctx: ExtensionContext, activeMessage?: unknown) => {
		const mosaicIdentity = readMosaicIdentityEnv();
		const name = cleanIdentityPart(ctx.sessionManager.getSessionName()) ?? mosaicIdentity?.name;
		editorSessionIdentity = mosaicIdentity ? { ...mosaicIdentity, name } : name ? { name } : undefined;

		const totals = getUsageTotals(ctx);
		const usage = ctx.getContextUsage();
		const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
		const measuredContextTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
		const contextMessages = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		).messages;
		const rawContext = estimateContextBreakdown(
			activeMessage ? [...contextMessages, activeMessage] : contextMessages,
			ctx.getSystemPrompt(),
		);
		const rawContextSegments = rawContext.segments;
		const estimatedContextTokens = Object.values(rawContextSegments).reduce((total, value) => total + value, 0);
		const storedContextUsed =
			measuredContextTokens ??
			(usage && contextWindow > 0 && usage.percent !== null
				? Math.round((usage.percent / 100) * contextWindow)
				: estimatedContextTokens);
		const contextUsed =
			activeMessage && measuredContextTokens !== undefined
				? Math.max(measuredContextTokens, estimatedContextTokens)
				: storedContextUsed;
		const scaledSlices = scaleContextSlicesToUsage(rawContext.slices, contextUsed);

		state.modelLabel = ctx.model?.name ?? "no-model";
		state.providerLabel = formatProviderLabel(ctx.model?.provider);
		state.thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
		state.contextPercent = usage?.percent ?? (contextWindow > 0 ? (contextUsed / contextWindow) * 100 : null);
		state.contextTotal = contextWindow;
		state.contextUsed = contextUsed;
		state.contextSegments = scaleContextSegmentsToUsage(rawContextSegments, contextUsed);
		state.contextSlices = scaledSlices;
		if (activeMessage && scaledSlices.length > 0) {
			pulseLastContextSlicesForMessage(activeMessage);
		}
		state.contextUsageEstimated = measuredContextTokens === undefined;
		state.tokenLabel = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
		state.costLabel = `$${totals.cost.toFixed(2)}`;
		state.hasTokens = totals.input > 0 || totals.output > 0;
		state.hasCost = totals.cost > 0;
	};

	const syncStateIfCurrent = (ctx: ExtensionContext, activeMessage?: unknown) => {
		if (disposed) return false;
		try {
			syncState(ctx, activeMessage);
			return true;
		} catch (error) {
			if (isStaleCtxError(error)) return false;
			throw error;
		}
	};

	const refreshProjectState = async (ctx: ExtensionContext, generation: number) => {
		const [gitStatus, runtime] = await Promise.all([readGitStatus(ctx.cwd), readRuntimeInfo(ctx.cwd)]);
		if (!isCurrent(generation)) return;
		Object.assign(state, gitStatus);
		state.runtime = runtime;
	};

	const scheduleProjectRefresh = (ctx: ExtensionContext, generation = uiGeneration) => {
		if (!isCurrent(generation)) return;
		if (projectRefreshInFlight) {
			projectRefreshPending = true;
			return;
		}
		projectRefreshInFlight = true;
		void refreshProjectState(ctx, generation).finally(() => {
			projectRefreshInFlight = false;
			if (isCurrent(generation)) refresh();
			if (projectRefreshPending) {
				projectRefreshPending = false;
				scheduleProjectRefresh(ctx, generation);
			}
		});
	};

	const stopRefreshTimer = () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	};

	const stopWorkingAnimation = () => {
		if (workingAnimationTimer) {
			clearInterval(workingAnimationTimer);
			workingAnimationTimer = null;
		}
	};

	const startWorkingAnimation = () => {
		setWorkingAnimationState(true, 0);
		stopWorkingAnimation();
		workingAnimationTimer = setInterval(() => {
			advanceWorkingAnimationFrame();
			refresh();
		}, 80);
		refresh();
	};

	const applyUsageResult = (provider: string, snapshot: UsageSnapshot) => {
		if (disposed) return;
		if (activeProvider !== provider) return;
		const cached = usageCache.get(provider);
		if (snapshot.windows.length === 0 && snapshot.error && cached?.windows.length) return;
		usageCache.set(provider, snapshot);
		state.usage = snapshot;
		state.usageLines = undefined;
		usageBarCache = null;
		usageBarPendingKey = null;
		refresh();
	};

	const fetchUsage = (modelProvider: string | undefined) => {
		const provider = detectUsageProvider(modelProvider);
		if (!provider) {
			activeProvider = null;
			state.usage = null;
			state.usageLines = undefined;
			usageBarCache = null;
			usageBarPendingKey = null;
			stopRefreshTimer();
			refresh();
			return;
		}

		activeProvider = provider;
		const cached = usageCache.get(provider);
		if (cached && cached.windows.length > 0) {
			state.usage = cached;
			state.usageLines = undefined;
			usageBarCache = null;
			usageBarPendingKey = null;
			refresh();
		} else {
			state.usage = null;
			state.usageLines = undefined;
			usageBarCache = null;
			usageBarPendingKey = null;
			refresh();
		}

		fetchUsageForProvider(provider)
			.then((snapshot) => applyUsageResult(provider, snapshot))
			.catch(() => {});
	};

	const startRefreshTimer = () => {
		stopRefreshTimer();
		refreshTimer = setInterval(() => {
			if (!activeProvider) return;
			const provider = activeProvider;
			fetchUsageForProvider(provider)
				.then((snapshot) => applyUsageResult(provider, snapshot))
				.catch(() => {});
		}, USAGE_REFRESH_INTERVAL);
	};

	const installFooter = (ctx: ExtensionContext) => {
		const generation = uiGeneration;
		syncStateIfCurrent(ctx);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const disposeFocusCursor = installFocusCursor(pi, ctx, tui);
			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleProjectRefresh(ctx, generation);
				tui.requestRender();
			});

			if (ctx.model?.provider) {
				fetchUsage(ctx.model.provider);
				startRefreshTimer();
			}

			return {
				dispose: () => {
					disposeFocusCursor();
					unsubscribeBranch();
					requestFooterRender = undefined;
					stopRefreshTimer();
					stopContextPulse();
				},
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		});
	};

	const installEditor = (ctx: ExtensionContext) => {
		syncStateIfCurrent(ctx);
		const cwd = ctx.cwd;
		setEditorSessionIdentityProvider(() => editorSessionIdentity);
		setEditorChromeProvider((width, theme, options) => {
			const bottomWidth = Math.max(1, width - options.modeReserve);
			if (isCompactTerminal()) {
				return {
					topRight: renderEditorTopChrome(width, theme, cwd),
				};
			}
			return {
				topRight: renderEditorTopChrome(width, theme, cwd),
				bottomRight: renderEditorBottomStatus(bottomWidth, theme),
			};
		});
		installEditorComposition(ctx.ui.theme, currentConfig.compact.minTerminalRows);
	};

	const installUi = (ctx: ExtensionContext) => {
		ensureConfigExists();
		currentConfig = loadConfig();
		usageBarsVisible = currentConfig.usageBars.visible;
		ctx.ui.setWorkingVisible(false);
		installFooter(ctx);
		installEditor(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	};

	pi.registerCommand("usage-bars", {
		description: "Show or hide provider usage bars in the editor status row",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "toggle"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (!mode) {
				ctx.ui.notify(`usage-bars ${usageBarsVisible ? "on" : "off"}`, "info");
				return;
			}
			if (mode !== "on" && mode !== "off" && mode !== "toggle") {
				ctx.ui.notify("Usage: /usage-bars [on|off]", "error");
				return;
			}
			usageBarsVisible = mode === "toggle" ? !usageBarsVisible : mode === "on";
			currentConfig = {
				...currentConfig,
				usageBars: {
					...currentConfig.usageBars,
					visible: usageBarsVisible,
				},
			};
			try {
				saveConfig(currentConfig);
			} catch {
				ctx.ui.notify("Failed to save usage-bars setting", "error");
				return;
			}
			if (usageBarsVisible && ctx.model?.provider) fetchUsage(ctx.model.provider);
			ctx.ui.notify(`usage-bars ${usageBarsVisible ? "on" : "off"}`, "info");
			refresh();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		disposed = false;
		uiGeneration++;
		installUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		uiGeneration++;
		requestFooterRender = undefined;
		unsubscribeSkillfulCache?.();
		unsubscribeSkillfulCache = undefined;
		setCachedSkillNames([]);
		setEditorChromeProvider(undefined);
		setEditorSessionIdentityProvider(undefined);
		editorSessionIdentity = undefined;
		setWorkingAnimationState(false, 0);
		stopRefreshTimer();
		stopContextPulse();
		stopWorkingAnimation();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		startWorkingAnimation();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		setWorkingAnimationState(false, 0);
		stopWorkingAnimation();
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("model_select", async (event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		if (event.model?.provider) {
			fetchUsage(event.model.provider);
			startRefreshTimer();
		}
		refresh();
	});

	pi.on("message_end", async (event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		pulseLastContextSlicesForMessage(event.message);
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("message_update", async (event, ctx) => {
		if (!syncStateIfCurrent(ctx, event.message)) return;
		refresh();
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		scheduleProjectRefresh(ctx);
		refresh();
	});

	unsubscribeSkillfulCache = pi.events.on("skillful:cache", (data) => {
		const names =
			data && typeof data === "object" && Array.isArray((data as { names?: unknown }).names)
				? (data as { names: unknown[] }).names.filter((name): name is string => typeof name === "string")
				: [];
		setCachedSkillNames(names);
		refresh();
	});
}
