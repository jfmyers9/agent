import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const LEVELS: readonly Level[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const VALID: ReadonlySet<Level> = new Set(LEVELS);

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

function saveMap(map: Record<string, Level>): void {
	writeFileSync(effortPath(), `${JSON.stringify(map, null, 2)}\n`);
}

function supportedLevels(ctx?: ExtensionContext): readonly Level[] {
	return ctx?.model ? (getSupportedThinkingLevels(ctx.model) as Level[]) : LEVELS;
}

export default function effortExtension(pi: ExtensionAPI) {
	let map = loadMap();

	function apply(ctx: ExtensionContext) {
		const id = ctx.model?.id;
		if (!id) return;
		const level = map[id];
		if (level) pi.setThinkingLevel(level);
	}

	pi.on("session_start", async (_e, ctx) => {
		map = loadMap();
		apply(ctx);
	});

	pi.on("model_select", async (_e, ctx) => {
		apply(ctx);
	});

	pi.registerCommand("effort", {
		description: "Set thinking effort for the current model and persist to effort.json",
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
				const current = map[id] ?? "(unset)";
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
			// Reload from disk before mutating so concurrent hand-edits aren't clobbered.
			const fresh = loadMap();
			fresh[id] = level;
			try {
				saveMap(fresh);
			} catch (err) {
				ctx.ui.notify(`Failed to save effort.json: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			map = fresh;
			pi.setThinkingLevel(level);
			ctx.ui.notify(`effort[${id}] = ${level}`, "info");
		},
	});
}
