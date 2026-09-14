import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CoordinatorLookup, hasActiveSubagents, installCoordinatorLookup } from "./runtime.ts";

type ExtensionModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type CoordinatorModule = { getCoordinatorForSession: CoordinatorLookup };

export default async function subagentsExtension(pi: ExtensionAPI): Promise<void> {
	// The pinned package exports its SDK at the root; its Pi entry is adjacent.
	const sdk = import.meta.resolve("@luan.sh/pi-subagents");
	const [extension, coordinator] = (await Promise.all([
		import(new URL("./extension.ts", sdk).href),
		import(new URL("./runtime/coordinator.ts", sdk).href),
	])) as [ExtensionModule, CoordinatorModule];
	installCoordinatorLookup(coordinator.getCoordinatorForSession);
	await extension.default(pi);
	pi.on("session_before_fork", (_event, ctx) => {
		if (!hasActiveSubagents(ctx.sessionManager.getSessionId())) return;
		ctx.ui.notify("Wait for or interrupt active subagents before forking the session.", "warning");
		return { cancel: true };
	});
}
