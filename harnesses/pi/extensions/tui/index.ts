import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ROUTING_MODEL, ROUTING_PROVIDER } from "../routing/settings";
import { terminalRows } from "../shared/terminal";
import { registerExtensionEntryRenderer } from "../shared/tui";
import { ensureConfigExists, loadConfig, type PolishedTuiConfig, saveConfig } from "./config";
import { costLabel, costReport, formatCost, getSessionCosts } from "./cost";
import { installFocusCursor } from "./cursor-focus";
import {
	advanceWorkingAnimation,
	type EditorSessionIdentity,
	installEditorComposition,
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
	renderUsageBar,
	scaleContextSegmentsToUsage,
	scaleContextSlicesToUsage,
} from "./footer";
import { readGitStatus } from "./git";
import { readRuntimeInfo } from "./runtime";
import { renderTurnDurationEntry, TURN_DURATION_ENTRY_TYPE, TurnDurationTimer } from "./turn-duration";
import { detectUsageProvider, fetchUsageForProvider, USAGE_REFRESH_INTERVAL, type UsageSnapshot } from "./usage";

type UsageBarCache = {
	key: string;
	theme: Parameters<typeof renderEditorContextStatus>[1];
	lines: string[];
};

const CONTEXT_PULSE_INTERVAL_MS = 320;
const CONTEXT_PULSE_DURATION_MS = 1200;
// Time-based shine/pulse: the heartbeat only samples wall-clock phase, so the
// animation speed no longer depends on how reliably these ticks fire.
const WORKING_ANIMATION_TICK_MS = 33;
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

function assistantProvider(message: unknown): string | undefined {
	return message &&
		typeof message === "object" &&
		"role" in message &&
		message.role === "assistant" &&
		"provider" in message &&
		typeof message.provider === "string"
		? message.provider
		: undefined;
}

function dispatchedProvider(ctx: ExtensionContext, activeMessage?: unknown): string | undefined {
	const selected = ctx.model;
	const virtual =
		selected?.api === ("pi-virtual" as string) ||
		(selected?.provider === ROUTING_PROVIDER && selected.id === ROUTING_MODEL);
	if (!virtual) return selected?.provider;
	const streaming = assistantProvider(activeMessage);
	if (streaming) return streaming;
	// Selection remains virtual. Dispatch is recorded on physical assistant messages,
	// including those before compaction; resume/tree navigation must stay on this branch.
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const provider = assistantProvider(entry.message);
		if (provider) return provider;
	}
	return undefined;
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
	let usageModelProvider: string | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let costTimer: ReturnType<typeof setInterval> | undefined;
	let usageBarCache: UsageBarCache | null = null;
	let usageBarsVisible = currentConfig.usageBars.visible;
	let contextPulseTimer: ReturnType<typeof setInterval> | null = null;
	let workingAnimationTimer: ReturnType<typeof setInterval> | null = null;
	const contextPulseDeadlines = new Map<number, number>();
	let disposed = false;
	let uiGeneration = 0;
	let editorSessionIdentity: EditorSessionIdentity | undefined;
	let mainAutoSelected = false;
	const turnDurationTimer = new TurnDurationTimer();

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

	const ensureUsageBarLines = (width: number, theme: Parameters<typeof renderEditorContextStatus>[1]) => {
		const key = usageBarKey(width);
		if (usageBarCache?.key === key && usageBarCache.theme === theme) {
			state.usageLines = usageBarCache.lines;
			return;
		}

		if (!state.usage?.windows.length) {
			state.usageLines = undefined;
			usageBarCache = null;
			return;
		}

		const lines = [renderUsageBar(state.providerLabel, state.usage.windows, theme, width)].filter(Boolean);
		usageBarCache = { key, theme, lines };
		state.usageLines = lines;
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
			ensureUsageBarLines(usageWidth, theme);
			usageLine = truncateUsageLine(state.usageLines?.[0] ?? "", usageWidth);
		}

		const gapWidth = usageLine ? 2 : 0;
		let statusWidth = safeWidth - visibleWidth(usageLine) - gapWidth;
		if (statusWidth < 24) {
			usageLine = "";
			statusWidth = safeWidth;
		}
		const fast = getFastStatus?.();
		// Read live status at render time: routing resolves after agent_start and
		// may update without a new context snapshot (including queued commands).
		const modelLabel = (mainAutoSelected && getRoutingStatus?.()) || state.modelLabel;
		const topState = { ...state, modelLabel: fast ? `${modelLabel} · ${fast}` : modelLabel };
		const topStatus = renderEditorTopStatus(topState, currentConfig, cwd, theme, statusWidth);
		return [usageLine, topStatus].filter(Boolean).join("  ");
	};

	const renderEditorBottomStatus = (width: number, theme: Parameters<typeof renderEditorContextStatus>[1]) => {
		const safeWidth = Math.max(1, width);
		const contextWidth = Math.min(Math.floor(safeWidth * 0.5), safeWidth);
		const parts: string[] = [];
		if (contextWidth >= 12) parts.push(renderEditorContextStatus(state, theme, contextWidth));
		return parts.join("  ");
	};

	const syncCosts = (ctx: ExtensionContext) => {
		const totals = getSessionCosts(ctx);
		state.tokenLabel = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
		state.costLabel = costLabel(totals);
		state.agentCostLabel = totals.children.length ? `agents ${formatCost(totals.agents)}` : undefined;
		state.hasTokens = totals.input > 0 || totals.output > 0;
		state.hasCost = totals.total > 0 || totals.missing > 0 || totals.children.length > 0;
	};

	const syncState = (ctx: ExtensionContext, activeMessage?: unknown) => {
		const mosaicIdentity = readMosaicIdentityEnv();
		const name = cleanIdentityPart(ctx.sessionManager.getSessionName()) ?? mosaicIdentity?.name;
		editorSessionIdentity = mosaicIdentity ? { ...mosaicIdentity, name } : name ? { name } : undefined;

		syncCosts(ctx);
		const usage = ctx.getContextUsage();
		// Pi already resolves virtual selections to the physical response's limits.
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
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

		mainAutoSelected = ctx.model?.provider === ROUTING_PROVIDER && ctx.model?.id === ROUTING_MODEL;
		state.modelLabel = ctx.model?.name ?? "no-model";
		usageModelProvider = dispatchedProvider(ctx, activeMessage);
		state.providerLabel = formatProviderLabel(usageModelProvider ?? ctx.model?.provider);
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
		if (detectUsageProvider(usageModelProvider) !== activeProvider) {
			fetchUsage(usageModelProvider);
			if (activeProvider) startRefreshTimer();
		}
	};

	const syncStateIfCurrent = (ctx: ExtensionContext, activeMessage?: unknown) => {
		if (disposed || !ctx.hasUI) return false;
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
			advanceWorkingAnimation();
			refresh();
		}, WORKING_ANIMATION_TICK_MS);
		refresh();
	};

	const applyUsageResult = (provider: string, snapshot: UsageSnapshot, generation: number) => {
		if (!isCurrent(generation)) return;
		if (activeProvider !== provider) return;
		const cached = usageCache.get(provider);
		if (snapshot.windows.length === 0 && snapshot.error && cached?.windows.length) return;
		usageCache.set(provider, snapshot);
		state.usage = snapshot;
		state.usageLines = undefined;
		usageBarCache = null;
		refresh();
	};

	const fetchUsage = (modelProvider: string | undefined) => {
		const provider = detectUsageProvider(modelProvider);
		if (!provider) {
			activeProvider = null;
			state.usage = null;
			state.usageLines = undefined;
			usageBarCache = null;
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
			refresh();
		} else {
			state.usage = null;
			state.usageLines = undefined;
			usageBarCache = null;
			refresh();
		}

		const generation = uiGeneration;
		fetchUsageForProvider(provider)
			.then((snapshot) => applyUsageResult(provider, snapshot, generation))
			.catch(() => {});
	};

	const startRefreshTimer = () => {
		stopRefreshTimer();
		const generation = uiGeneration;
		refreshTimer = setInterval(() => {
			if (!activeProvider) return;
			const provider = activeProvider;
			fetchUsageForProvider(provider)
				.then((snapshot) => applyUsageResult(provider, snapshot, generation))
				.catch(() => {});
		}, USAGE_REFRESH_INTERVAL);
	};

	let getFastStatus: (() => string | undefined) | undefined;
	let getRoutingStatus: (() => string | undefined) | undefined;
	const installFooter = (ctx: ExtensionContext) => {
		const generation = uiGeneration;
		syncStateIfCurrent(ctx);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			getFastStatus = () => footerData.getExtensionStatuses().get("openai-fast-mode");
			getRoutingStatus = () => footerData.getExtensionStatuses().get("routing");
			requestFooterRender = () => tui.requestRender();
			const disposeFocusCursor = installFocusCursor(pi, ctx, tui);
			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleProjectRefresh(ctx, generation);
				tui.requestRender();
			});

			if (activeProvider) startRefreshTimer();

			return {
				dispose: () => {
					getFastStatus = undefined;
					getRoutingStatus = undefined;
					disposeFocusCursor();
					unsubscribeBranch();
					requestFooterRender = undefined;
					stopRefreshTimer();
					stopContextPulse();
				},
				invalidate() {
					usageBarCache = null;
				},
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
		activeProvider = null;
		state.usage = null;
		state.usageLines = undefined;
		usageBarCache = null;
		stopRefreshTimer();
		ctx.ui.setWorkingVisible(false);
		installFooter(ctx);
		installEditor(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	};

	pi.registerCommand("cost", {
		description: "Session list-price cost, including all subagents and branches",
		handler: async (_args, ctx) => {
			ctx.ui.notify(costReport(getSessionCosts(ctx)), "info");
		},
	});

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
				ctx.ui.notify("Usage: /usage-bars [on|off|toggle]", "error");
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
			if (usageBarsVisible) {
				if (!syncStateIfCurrent(ctx)) return;
				fetchUsage(usageModelProvider);
			}
			ctx.ui.notify(`usage-bars ${usageBarsVisible ? "on" : "off"}`, "info");
			refresh();
		},
	});

	registerExtensionEntryRenderer(pi, TURN_DURATION_ENTRY_TYPE, (entry, _options, theme) =>
		renderTurnDurationEntry(entry.data, theme),
	);

	pi.on("session_start", async (_event, ctx) => {
		// Headless children share the editor prototype with the interactive parent.
		if (!ctx.hasUI) return;
		disposed = false;
		uiGeneration++;
		installUi(ctx);
		if (costTimer) clearInterval(costTimer);
		// Children can keep working while the parent is idle. Poll only accounting,
		// not context layout; also catches usage entries with no message event.
		costTimer = setInterval(() => {
			if (disposed) return;
			try {
				syncCosts(ctx);
				refresh();
			} catch (error) {
				if (costTimer) clearInterval(costTimer);
				costTimer = undefined;
				if (!isStaleCtxError(error)) {
					state.costLabel = `${state.costLabel} ?`;
					refresh();
					ctx.ui.notify(
						`Cost updates paused: ${error instanceof Error ? error.message : String(error)}. Reload to retry.`,
						"warning",
					);
				}
			}
		}, 1000);
		costTimer.unref?.();
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (syncStateIfCurrent(ctx)) refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		disposed = true;
		if (costTimer) clearInterval(costTimer);
		costTimer = undefined;
		uiGeneration++;
		requestFooterRender = undefined;
		setEditorChromeProvider(undefined);
		setEditorSessionIdentityProvider(undefined);
		editorSessionIdentity = undefined;
		setWorkingAnimationState(false, 0);
		stopRefreshTimer();
		stopContextPulse();
		stopWorkingAnimation();
		turnDurationTimer.reset();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		turnDurationTimer.start();
		startWorkingAnimation();
	});

	pi.on("agent_end", async (_event, ctx) => {
		const turnDuration = turnDurationTimer.finish();
		if (turnDuration) pi.appendEntry(TURN_DURATION_ENTRY_TYPE, turnDuration);
		if (!syncStateIfCurrent(ctx)) return;
		setWorkingAnimationState(false, 0);
		stopWorkingAnimation();
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		refresh();
	});

	pi.on("message_start", async (event, ctx) => {
		if (!assistantProvider(event.message)) return;
		if (!syncStateIfCurrent(ctx, event.message)) return;
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
}
