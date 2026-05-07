import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ThemeColor } from "@earendil-works/pi-coding-agent";

export type UsageHudConfig = {
	icons: {
		cwd: string;
		git: string;
	};
	colors: {
		cwdText: ThemeColor;
		git: ThemeColor;
		contextNormal: ThemeColor;
		contextWarning: ThemeColor;
		contextError: ThemeColor;
		tokens: ThemeColor;
		cost: ThemeColor;
		separator: ThemeColor;
	};
	usageHud: {
		contextWarningPercent: number;
		contextErrorPercent: number;
		compactMinRows: number;
	};
};

const themeColors = new Set<ThemeColor>([
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
]);

export const defaultConfig: UsageHudConfig = {
	icons: {
		cwd: "󰝰",
		git: "",
	},
	colors: {
		cwdText: "syntaxOperator",
		git: "syntaxKeyword",
		contextNormal: "muted",
		contextWarning: "warning",
		contextError: "error",
		tokens: "muted",
		cost: "success",
		separator: "borderMuted",
	},
	usageHud: {
		contextWarningPercent: 70,
		contextErrorPercent: 90,
		compactMinRows: 18,
	},
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function colorValue(value: unknown, fallback: ThemeColor): ThemeColor {
	return typeof value === "string" && themeColors.has(value as ThemeColor)
		? (value as ThemeColor)
		: fallback;
}

function percentValue(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(100, value));
}

function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

export function loadConfigFromPath(path: string): UsageHudConfig {
	try {
		if (!existsSync(path)) return defaultConfig;
		const parsed = asObject(JSON.parse(readFileSync(path, "utf8")));
		const icons = asObject(parsed.icons);
		const colors = asObject(parsed.colors);
		const usageHud = asObject(parsed.usageHud);
		return {
			icons: {
				cwd: stringValue(icons.cwd, defaultConfig.icons.cwd),
				git: stringValue(icons.git, defaultConfig.icons.git),
			},
			colors: {
				cwdText: colorValue(colors.cwdText, defaultConfig.colors.cwdText),
				git: colorValue(colors.git, defaultConfig.colors.git),
				contextNormal: colorValue(
					colors.contextNormal,
					defaultConfig.colors.contextNormal,
				),
				contextWarning: colorValue(
					colors.contextWarning,
					defaultConfig.colors.contextWarning,
				),
				contextError: colorValue(
					colors.contextError,
					defaultConfig.colors.contextError,
				),
				tokens: colorValue(colors.tokens, defaultConfig.colors.tokens),
				cost: colorValue(colors.cost, defaultConfig.colors.cost),
				separator: colorValue(colors.separator, defaultConfig.colors.separator),
			},
			usageHud: {
				contextWarningPercent: percentValue(
					usageHud.contextWarningPercent,
					defaultConfig.usageHud.contextWarningPercent,
				),
				contextErrorPercent: percentValue(
					usageHud.contextErrorPercent,
					defaultConfig.usageHud.contextErrorPercent,
				),
				compactMinRows: positiveInteger(
					usageHud.compactMinRows,
					defaultConfig.usageHud.compactMinRows,
				),
			},
		};
	} catch {
		return defaultConfig;
	}
}

export function loadConfig(): UsageHudConfig {
	return loadConfigFromPath(join(getAgentDir(), "tui.json"));
}
