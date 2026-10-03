import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPackageExtension } from "../shared/package-extension";
import { installNativeToolBridge } from "./native-tool-bridge";
import { installCodeModeRenderer } from "./codemode-renderer";

export default async function runtimeSupport(pi: ExtensionAPI): Promise<void> {
	installCodeModeRenderer(pi);
	await loadPackageExtension("@luan.sh/pi-libtui", pi);
	await loadPackageExtension("@luan.sh/pi-xsettings", pi);

	let removeNativeToolBridge: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		// Session switches can emit start again without disposing this runtime.
		if (ctx.hasUI && ctx.mode === "tui") removeNativeToolBridge ??= installNativeToolBridge();
	});
	pi.on("session_shutdown", () => {
		removeNativeToolBridge?.();
		removeNativeToolBridge = undefined;
	});
}
