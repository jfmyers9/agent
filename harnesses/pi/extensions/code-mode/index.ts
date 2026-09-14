import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageExtension } from "../shared/package-extension";

export default async function codeMode(pi: ExtensionAPI): Promise<void> {
	await loadPackageExtension("@luan.sh/pi-code-mode", pi);
}
