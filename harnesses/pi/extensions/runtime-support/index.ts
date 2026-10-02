import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageExtension } from "../shared/package-extension";

export default async function runtimeSupport(pi: ExtensionAPI): Promise<void> {
	await loadPackageExtension("@luan.sh/pi-libtui", pi);
	await loadPackageExtension("@luan.sh/pi-xsettings", pi);
}
