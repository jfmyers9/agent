// @ts-nocheck
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type QuotaWindow = {
	label: string;
	usedPercent: number;
	windowSecs: number;
	resetSecs: number;
};

export type QuotaSnapshot = {
	provider: string;
	windows: QuotaWindow[];
	fetchedAt: number;
	error?: string;
};

export const QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000;

const PROVIDER_MAP: Record<string, "codex"> = {
	"openai-codex": "codex",
};

type CodexCredentials = {
	token: string;
	accountId?: string;
};

function loadJson(path: string): Record<string, unknown> {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
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
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
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

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function getCodexCredentials(): CodexCredentials | undefined {
	const piAuth = loadJson(join(homedir(), ".pi", "agent", "auth.json"));
	const piCodex = objectField(piAuth["openai-codex"]);
	const piToken = resolveAuthValue(
		piCodex.access ?? piCodex.key ?? piCodex.refresh,
	);
	if (piToken) {
		return {
			token: piToken,
			accountId: stringField(piCodex.accountId ?? piCodex.account_id),
		};
	}

	const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
	const codexAuth = loadJson(join(codexHome, "auth.json"));
	const apiKey = resolveAuthValue(codexAuth.OPENAI_API_KEY);
	if (apiKey) return { token: apiKey };

	const tokens = objectField(codexAuth.tokens);
	const accessToken = stringField(tokens.access_token);
	if (!accessToken) return undefined;
	return {
		token: accessToken,
		accountId: stringField(tokens.account_id),
	};
}

function secondsUntil(epochSeconds: number | undefined): number {
	if (!epochSeconds || !Number.isFinite(epochSeconds)) return 0;
	return Math.max(0, Math.floor(epochSeconds - Date.now() / 1000));
}

function clampPercent(value: unknown): number {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(number)) return 0;
	return Math.max(0, Math.min(100, number));
}

function getWindowLabel(windowSecs: number, fallback: string): string {
	if (!Number.isFinite(windowSecs) || windowSecs <= 0) return fallback;
	const hours = windowSecs / 3600;
	const days = windowSecs / 86_400;
	if (Math.abs(hours - 5) <= 2) return "5h";
	if (Math.abs(days - 7) <= 1) return "Week";
	if (hours >= 1 && hours < 48) return `${Math.round(hours)}h`;
	if (days >= 1) return `${Math.round(days)}d`;
	return `${Math.max(1, Math.round(windowSecs / 60))}m`;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs = 5000,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

function parseCodexWindow(
	value: unknown,
	fallbackLabel: string,
): QuotaWindow | undefined {
	const window = objectField(value);
	const windowSecs = Number(window.limit_window_seconds ?? 0);
	const resetAt = Number(window.reset_at ?? 0);
	const usedPercent = clampPercent(window.used_percent);
	if (!windowSecs && !resetAt && !usedPercent) return undefined;
	return {
		label: getWindowLabel(windowSecs, fallbackLabel),
		usedPercent,
		windowSecs: Math.max(0, Math.round(windowSecs)),
		resetSecs: secondsUntil(resetAt),
	};
}

async function fetchCodexQuota(): Promise<QuotaSnapshot> {
	const credentials = getCodexCredentials();
	if (!credentials) {
		return {
			provider: "OpenAI",
			windows: [],
			fetchedAt: Date.now(),
			error: "no-auth",
		};
	}

	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${credentials.token}`,
			"User-Agent": "pi-usage-hud",
		};
		if (credentials.accountId) {
			headers["ChatGPT-Account-Id"] = credentials.accountId;
		}

		const response = await fetchWithTimeout(
			"https://chatgpt.com/backend-api/wham/usage",
			{ headers },
		);
		if (!response.ok) {
			return {
				provider: "OpenAI",
				windows: [],
				fetchedAt: Date.now(),
				error: `HTTP ${response.status}`,
			};
		}

		const data = objectField(await response.json());
		const rateLimit = objectField(data.rate_limit);
		const windows = [
			parseCodexWindow(rateLimit.primary_window, "5h"),
			parseCodexWindow(rateLimit.secondary_window, "Week"),
		].filter((window): window is QuotaWindow => Boolean(window));

		return { provider: "OpenAI", windows, fetchedAt: Date.now() };
	} catch (error) {
		return {
			provider: "OpenAI",
			windows: [],
			fetchedAt: Date.now(),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function detectQuotaProvider(
	modelProvider: string | undefined,
): "codex" | null {
	if (!modelProvider) return null;
	return PROVIDER_MAP[modelProvider] ?? null;
}

export async function fetchQuotaForProvider(
	provider: "codex",
): Promise<QuotaSnapshot> {
	switch (provider) {
		case "codex":
			return fetchCodexQuota();
	}
}
