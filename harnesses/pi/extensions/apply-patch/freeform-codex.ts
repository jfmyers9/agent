import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ApplyPatchFreeformOptions = {
	description: string;
	grammar: string;
};

export function registerApplyPatchFreeformProvider(_pi: ExtensionAPI, _options: ApplyPatchFreeformOptions): void {
	// This repo does not carry upstream's Codex-native provider bridge. The normal
	// structured apply_patch tool remains registered by index.ts.
}
