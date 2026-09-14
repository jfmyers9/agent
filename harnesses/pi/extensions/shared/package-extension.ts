import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Load a pinned package's Pi entry without also auto-loading its companions. */
export async function loadPackageExtension(name: string, pi: ExtensionAPI, from = import.meta.url): Promise<void> {
	const entry = createRequire(from).resolve(name);
	const module = (await import(new URL("./extension.ts", pathToFileURL(entry)).href)) as {
		default: (api: ExtensionAPI) => void | Promise<void>;
	};
	await module.default(pi);
}
