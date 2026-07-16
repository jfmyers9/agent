import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const LEVELS: readonly Level[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const VALID: ReadonlySet<Level> = new Set(LEVELS);
const ENTRY_TYPE = "effort-model-level";

interface EffortEntry {
	modelId: string;
	level: Level;
}

function effortPath(): string {
	return join(getAgentDir(), "effort.json");
}

function loadMap(): Record<string, Level> {
	const path = effortPath();
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const out: Record<string, Level> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v === "string" && VALID.has(v as Level)) out[k] = v as Level;
		}
		return out;
	} catch (err) {
		console.error(`[effort] failed to load ${path}: ${err}`);
		return {};
	}
}

function effortEntry(data: unknown): EffortEntry | undefined {
	if (!data || typeof data !== "object") return undefined;
	const { modelId, level } = data as Record<string, unknown>;
	if (typeof modelId !== "string" || typeof level !== "string" || !VALID.has(level as Level)) return undefined;
	return { modelId, level: level as Level };
}

function supportedLevels(ctx?: ExtensionContext): readonly Level[] {
	return ctx?.model ? (getSupportedThinkingLevels(ctx.model) as Level[]) : LEVELS;
}

export default function effortExtension(pi: ExtensionAPI, loadDefaults: () => Record<string, Level> = loadMap) {
	let defaults = loadDefaults();
	let overrides: Record<string, Level> = {};

	function apply(ctx: ExtensionContext) {
		const id = ctx.model?.id;
		if (!id) return;
		const level = overrides[id] ?? defaults[id];
		if (level) pi.setThinkingLevel(level);
	}

	pi.on("session_start", async (_e, ctx) => {
		defaults = loadDefaults();
		overrides = {};
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const saved = effortEntry(entry.data);
			if (saved) overrides[saved.modelId] = saved.level;
		}
		apply(ctx);
	});

	pi.on("model_select", async (_e, ctx) => {
		apply(ctx);
	});

	pi.registerCommand("effort", {
		description: "Set thinking effort for the current model in this session",
		getArgumentCompletions: (prefix: string, ctx?: ExtensionContext): AutocompleteItem[] | null => {
			const items = supportedLevels(ctx)
				.filter((l) => l.startsWith(prefix))
				.map((l) => ({
					value: l,
					label: l,
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const id = ctx.model?.id;
			if (!id) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}
			const arg = args.trim();
			if (!arg) {
				const current = overrides[id] ?? defaults[id] ?? pi.getThinkingLevel();
				ctx.ui.notify(`effort[${id}] = ${current}`, "info");
				return;
			}
			if (!VALID.has(arg as Level)) {
				ctx.ui.notify(`Invalid level "${arg}". Valid: ${LEVELS.join(", ")}`, "error");
				return;
			}
			const level = arg as Level;
			const supported = supportedLevels(ctx);
			if (!supported.includes(level)) {
				ctx.ui.notify(`Level "${level}" is not supported by ${id}. Supported: ${supported.join(", ")}`, "error");
				return;
			}
			overrides[id] = level;
			pi.appendEntry(ENTRY_TYPE, { modelId: id, level } satisfies EffortEntry);
			pi.setThinkingLevel(level);
			ctx.ui.notify(`effort[${id}] = ${level}`, "info");
		},
	});
}
