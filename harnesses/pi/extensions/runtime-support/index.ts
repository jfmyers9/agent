import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageExtension } from "../shared/package-extension";

export default async function runtimeSupport(pi: ExtensionAPI): Promise<void> {
	const codeMode = createRequire(import.meta.url).resolve("@luan.sh/pi-code-mode");
	await loadPackageExtension("@luan.sh/pi-libtui", pi, pathToFileURL(codeMode).href);
	await loadPackageExtension("@luan.sh/pi-xsettings", pi);
}
