import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isModelRef } from "./settings.js";
import type { ModelRef } from "./types.js";

export const PIN_ENTRY = "routing:pin-v1";

/** Latest branch-local manual model pin; null explicitly clears an earlier pin. */
export function manualPin(ctx: Pick<ExtensionContext, "sessionManager">): ModelRef | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== PIN_ENTRY) continue;
		const data = entry.data as { version?: unknown; model?: unknown } | undefined;
		if (data?.version !== 1) continue;
		return isModelRef(data.model) ? data.model : undefined;
	}
	return undefined;
}

export function recordPin(pi: { appendEntry: (type: string, data: unknown) => void }, model?: ModelRef): void {
	pi.appendEntry(PIN_ENTRY, { version: 1, model: model ?? null });
}
