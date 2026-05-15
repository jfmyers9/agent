import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RateWindow {
	label: string;
	usedPercent: number;
	windowSecs: number;
	resetSecs: number;
}

export interface UsageSnapshot {
	provider: string;
	windows: RateWindow[];
	error?: string;
	fetchedAt: number;
}

export const USAGE_REFRESH_INTERVAL = 5 * 60_000;

const FIVE_HOURS_SECS = 5 * 60 * 60;
const SEVEN_DAYS_SECS = 7 * 24 * 60 * 60;
const THIRTY_DAYS_SECS = 30 * 24 * 60 * 60;

const PROVIDER_MAP: Record<string, string> = {
	anthropic: "claude",
	"openai-codex": "codex",
	"github-copilot": "copilot",
	"google-gemini-cli": "gemini",
	minimax: "minimax",
	"minimax-cn": "minimax-cn",
};

export function detectUsageProvider(modelProvider: string | undefined): string | null {
	if (!modelProvider) return null;
	return PROVIDER_MAP[modelProvider] ?? null;
}

function loadAuthJson(): Record<string, any> {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	try {
		if (existsSync(authPath)) {
			return JSON.parse(readFileSync(authPath, "utf-8"));
		}
	} catch {}
	return {};
}

function resolveAuthValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	if (trimmed.startsWith("!")) {
		try {
			const output = execSync(trimmed.slice(1), {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 2000,
			}).trim();
			return output || undefined;
		} catch {
			return undefined;
		}
	}

	if (/^[A-Z][A-Z0-9_]*$/.test(trimmed) && process.env[trimmed]) {
		return process.env[trimmed];
	}

	return trimmed;
}

function getApiKey(providerKey: string, envVar: string): string | undefined {
	if (process.env[envVar]) return process.env[envVar];

	const auth = loadAuthJson();
	const entry = auth[providerKey];
	if (!entry) return undefined;

	if (typeof entry === "string") return resolveAuthValue(entry);
	return resolveAuthValue(entry.key ?? entry.access ?? entry.refresh);
}

function getClaudeToken(): string | undefined {
	const auth = loadAuthJson();
	if (auth.anthropic?.access) return auth.anthropic.access;

	try {
		const keychainData = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData);
			if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth.accessToken;
		}
	} catch {}

	return undefined;
}

function getCopilotToken(): string | undefined {
	return loadAuthJson()["github-copilot"]?.refresh;
}

function getCodexToken(): { token: string; accountId?: string } | undefined {
	const auth = loadAuthJson();
	if (auth["openai-codex"]?.access) {
		return {
			token: auth["openai-codex"].access,
			accountId: auth["openai-codex"]?.accountId,
		};
	}

	const codexPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
	try {
		if (existsSync(codexPath)) {
			const data = JSON.parse(readFileSync(codexPath, "utf-8"));
			if (data.OPENAI_API_KEY) return { token: data.OPENAI_API_KEY };
			if (data.tokens?.access_token) {
				return {
					token: data.tokens.access_token,
					accountId: data.tokens.account_id,
				};
			}
		}
	} catch {}

	return undefined;
}

function getGeminiToken(): string | undefined {
	const auth = loadAuthJson();
	if (auth["google-gemini-cli"]?.access) return auth["google-gemini-cli"].access;

	const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
	try {
		if (existsSync(geminiPath)) {
			return JSON.parse(readFileSync(geminiPath, "utf-8")).access_token;
		}
	} catch {}

	return undefined;
}

function getMinimaxToken(provider: "minimax" | "minimax-cn"): string | undefined {
	return provider === "minimax"
		? getApiKey("minimax", "MINIMAX_API_KEY")
		: getApiKey("minimax-cn", "MINIMAX_CN_API_KEY");
}

function secondsUntil(date: Date | undefined): number {
	if (!date) return 0;
	return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
}

function secondsFromMs(durationMs: number | undefined): number {
	if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
	return Math.max(0, Math.round(durationMs / 1000));
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

function normalizePercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const normalized = value <= 1 && value >= 0 ? value * 100 : value;
	return Math.max(0, Math.min(100, normalized));
}

function getWindowLabel(durationMs: number | undefined, fallback: string): string {
	if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return fallback;

	const hourMs = 60 * 60 * 1000;
	const dayMs = 24 * hourMs;
	const weekMs = 7 * dayMs;

	const isCloseToWeek = Math.abs(durationMs - weekMs) <= hourMs * 2;
	const isCloseToDay = Math.abs(durationMs - dayMs) <= hourMs * 2;
	const isCloseTo5h = Math.abs(durationMs - 5 * hourMs) <= hourMs * 2;

	if (isCloseToWeek || fallback === "Week") return "Week";
	if (isCloseToDay || fallback === "Day") return "Day";
	if (isCloseTo5h || fallback === "5h") return fallback;

	const hours = Math.round(durationMs / hourMs);
	if (hours >= 1 && hours < 48) return `${hours}h`;

	const days = Math.round(durationMs / dayMs);
	if (days >= 1) return `${days}d`;

	const mins = Math.max(1, Math.round(durationMs / 60000));
	return `${mins}m`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 5000): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
	const token = getClaudeToken();
	if (!token) {
		return {
			provider: "Claude",
			windows: [],
			error: "no-auth",
			fetchedAt: Date.now(),
		};
	}

	try {
		const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
		});

		if (!res.ok) {
			return {
				provider: "Claude",
				windows: [],
				error: `HTTP ${res.status}`,
				fetchedAt: Date.now(),
			};
		}

		const data = (await res.json()) as any;
		const windows: RateWindow[] = [];

		if (data.five_hour?.utilization !== undefined) {
			const resetDate = data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : undefined;
			windows.push({
				label: "5h",
				usedPercent: normalizePercent(data.five_hour.utilization),
				windowSecs: FIVE_HOURS_SECS,
				resetSecs: secondsUntil(resetDate),
			});
		}

		if (data.seven_day?.utilization !== undefined) {
			const resetDate = data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : undefined;
			windows.push({
				label: "Week",
				usedPercent: normalizePercent(data.seven_day.utilization),
				windowSecs: SEVEN_DAYS_SECS,
				resetSecs: secondsUntil(resetDate),
			});
		}

		return { provider: "Claude", windows, fetchedAt: Date.now() };
	} catch (e) {
		return {
			provider: "Claude",
			windows: [],
			error: String(e),
			fetchedAt: Date.now(),
		};
	}
}

async function fetchCopilotUsage(): Promise<UsageSnapshot> {
	const token = getCopilotToken();
	if (!token) {
		return {
			provider: "Copilot",
			windows: [],
			error: "no-auth",
			fetchedAt: Date.now(),
		};
	}

	try {
		const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
			headers: {
				"Editor-Version": "vscode/1.96.2",
				"User-Agent": "GitHubCopilotChat/0.26.7",
				"X-Github-Api-Version": "2025-04-01",
				Accept: "application/json",
				Authorization: `token ${token}`,
			},
		});

		if (!res.ok) {
			return {
				provider: "Copilot",
				windows: [],
				error: `HTTP ${res.status}`,
				fetchedAt: Date.now(),
			};
		}

		const data = (await res.json()) as any;
		const windows: RateWindow[] = [];

		const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
		const resetSecs = secondsUntil(resetDate);

		if (data.quota_snapshots?.premium_interactions) {
			const pi = data.quota_snapshots.premium_interactions;
			windows.push({
				label: "Premium",
				usedPercent: clampPercent(100 - (pi.percent_remaining || 0)),
				windowSecs: THIRTY_DAYS_SECS,
				resetSecs,
			});
		}

		if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
			const chat = data.quota_snapshots.chat;
			windows.push({
				label: "Chat",
				usedPercent: clampPercent(100 - (chat.percent_remaining || 0)),
				windowSecs: THIRTY_DAYS_SECS,
				resetSecs,
			});
		}

		return { provider: "Copilot", windows, fetchedAt: Date.now() };
	} catch (e) {
		return {
			provider: "Copilot",
			windows: [],
			error: String(e),
			fetchedAt: Date.now(),
		};
	}
}

async function fetchCodexUsage(): Promise<UsageSnapshot> {
	const creds = getCodexToken();
	if (!creds) {
		return {
			provider: "Codex",
			windows: [],
			error: "no-auth",
			fetchedAt: Date.now(),
		};
	}

	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${creds.token}`,
			"User-Agent": "pi-agent",
			Accept: "application/json",
		};
		if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;

		const res = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers,
		});

		if (!res.ok) {
			return {
				provider: "Codex",
				windows: [],
				error: `HTTP ${res.status}`,
				fetchedAt: Date.now(),
			};
		}

		const data = (await res.json()) as any;
		const windows: RateWindow[] = [];

		if (data.rate_limit?.primary_window) {
			const pw = data.rate_limit.primary_window;
			const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
			const durationMs = typeof pw.limit_window_seconds === "number" ? pw.limit_window_seconds * 1000 : undefined;
			windows.push({
				label: getWindowLabel(durationMs, "5h"),
				usedPercent: clampPercent(pw.used_percent || 0),
				windowSecs: secondsFromMs(durationMs),
				resetSecs: secondsUntil(resetDate),
			});
		}

		if (data.rate_limit?.secondary_window) {
			const sw = data.rate_limit.secondary_window;
			const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
			const durationMs = typeof sw.limit_window_seconds === "number" ? sw.limit_window_seconds * 1000 : undefined;
			windows.push({
				label: getWindowLabel(durationMs, "Week"),
				usedPercent: clampPercent(sw.used_percent || 0),
				windowSecs: secondsFromMs(durationMs),
				resetSecs: secondsUntil(resetDate),
			});
		}

		return { provider: "Codex", windows, fetchedAt: Date.now() };
	} catch (e) {
		return {
			provider: "Codex",
			windows: [],
			error: String(e),
			fetchedAt: Date.now(),
		};
	}
}

async function fetchGeminiUsage(): Promise<UsageSnapshot> {
	const token = getGeminiToken();
	if (!token) {
		return {
			provider: "Gemini",
			windows: [],
			error: "no-auth",
			fetchedAt: Date.now(),
		};
	}

	try {
		const res = await fetchWithTimeout("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		});

		if (!res.ok) {
			return {
				provider: "Gemini",
				windows: [],
				error: `HTTP ${res.status}`,
				fetchedAt: Date.now(),
			};
		}

		const data = (await res.json()) as any;
		const quotas: Record<string, number> = {};

		for (const bucket of data.buckets || []) {
			const model = bucket.modelId || "unknown";
			const frac = bucket.remainingFraction ?? 1;
			if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
		}

		const windows: RateWindow[] = [];
		let proMin = 1;
		let flashMin = 1;
		let hasProModel = false;
		let hasFlashModel = false;

		for (const [model, frac] of Object.entries(quotas)) {
			if (model.toLowerCase().includes("pro")) {
				hasProModel = true;
				if (frac < proMin) proMin = frac;
			}
			if (model.toLowerCase().includes("flash")) {
				hasFlashModel = true;
				if (frac < flashMin) flashMin = frac;
			}
		}

		if (hasProModel)
			windows.push({
				label: "Pro",
				usedPercent: clampPercent((1 - proMin) * 100),
				windowSecs: 0,
				resetSecs: 0,
			});
		if (hasFlashModel)
			windows.push({
				label: "Flash",
				usedPercent: clampPercent((1 - flashMin) * 100),
				windowSecs: 0,
				resetSecs: 0,
			});

		return { provider: "Gemini", windows, fetchedAt: Date.now() };
	} catch (e) {
		return {
			provider: "Gemini",
			windows: [],
			error: String(e),
			fetchedAt: Date.now(),
		};
	}
}

async function fetchMinimaxUsage(provider: "minimax" | "minimax-cn"): Promise<UsageSnapshot> {
	const token = getMinimaxToken(provider);
	const providerLabel = provider === "minimax-cn" ? "MiniMax CN" : "MiniMax";
	const endpoint =
		provider === "minimax-cn"
			? "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"
			: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

	if (!token) {
		return {
			provider: providerLabel,
			windows: [],
			error: "no-auth",
			fetchedAt: Date.now(),
		};
	}

	try {
		const res = await fetchWithTimeout(endpoint, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!res.ok) {
			return {
				provider: providerLabel,
				windows: [],
				error: `HTTP ${res.status}`,
				fetchedAt: Date.now(),
			};
		}

		const data = (await res.json()) as any;
		const baseResp = data?.base_resp;
		if (baseResp?.status_code && baseResp.status_code !== 0) {
			return {
				provider: providerLabel,
				windows: [],
				error: baseResp.status_msg || `API ${baseResp.status_code}`,
				fetchedAt: Date.now(),
			};
		}

		const remains = Array.isArray(data?.model_remains) ? data.model_remains : [];
		const textBucket =
			remains.find((entry: any) => typeof entry?.model_name === "string" && /^minimax-m/i.test(entry.model_name)) ||
			remains.find((entry: any) => typeof entry?.model_name === "string" && /minimax/i.test(entry.model_name)) ||
			remains[0];

		if (!textBucket) {
			return {
				provider: providerLabel,
				windows: [],
				error: "no-usage-data",
				fetchedAt: Date.now(),
			};
		}

		const windows: RateWindow[] = [];

		const intervalTotal = Number(textBucket.current_interval_total_count) || 0;
		const intervalRemaining = Number(textBucket.current_interval_usage_count) || 0;
		if (intervalTotal > 0) {
			const used = intervalTotal - intervalRemaining;
			const usedPercent = clampPercent((used / intervalTotal) * 100);
			const resetDate = textBucket.end_time ? new Date(Number(textBucket.end_time)) : undefined;
			const durationMs =
				textBucket.start_time && textBucket.end_time
					? Number(textBucket.end_time) - Number(textBucket.start_time)
					: undefined;
			windows.push({
				label: getWindowLabel(durationMs, "5h"),
				usedPercent,
				windowSecs: secondsFromMs(durationMs),
				resetSecs: secondsUntil(resetDate),
			});
		}

		const weeklyTotal = Number(textBucket.current_weekly_total_count) || 0;
		const weeklyRemaining = Number(textBucket.current_weekly_usage_count) || 0;
		if (weeklyTotal > 0) {
			const used = weeklyTotal - weeklyRemaining;
			const usedPercent = clampPercent((used / weeklyTotal) * 100);
			const resetDate = textBucket.weekly_end_time ? new Date(Number(textBucket.weekly_end_time)) : undefined;
			const durationMs =
				textBucket.weekly_start_time && textBucket.weekly_end_time
					? Number(textBucket.weekly_end_time) - Number(textBucket.weekly_start_time)
					: undefined;
			windows.push({
				label: getWindowLabel(durationMs, "Week"),
				usedPercent,
				windowSecs: secondsFromMs(durationMs),
				resetSecs: secondsUntil(resetDate),
			});
		}

		return { provider: providerLabel, windows, fetchedAt: Date.now() };
	} catch (e) {
		return {
			provider: providerLabel,
			windows: [],
			error: String(e),
			fetchedAt: Date.now(),
		};
	}
}

export async function fetchUsageForProvider(provider: string): Promise<UsageSnapshot> {
	switch (provider) {
		case "claude":
			return fetchClaudeUsage();
		case "codex":
			return fetchCodexUsage();
		case "copilot":
			return fetchCopilotUsage();
		case "gemini":
			return fetchGeminiUsage();
		case "minimax":
			return fetchMinimaxUsage("minimax");
		case "minimax-cn":
			return fetchMinimaxUsage("minimax-cn");
		default:
			return {
				provider: "Unknown",
				windows: [],
				error: "unknown-provider",
				fetchedAt: Date.now(),
			};
	}
}
