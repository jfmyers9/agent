import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageExtension } from "./shared/package-extension";

export default async function tuicr(pi: ExtensionAPI): Promise<void> {
	// runtime-support already owns the shared UI and shortcut hosts. Load only
	// the review entry, not the companion host bundled in the package manifest.
	await loadPackageExtension("@luan.sh/pi-tuicr", pi);
}
