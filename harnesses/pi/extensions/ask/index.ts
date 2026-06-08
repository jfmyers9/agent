import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "./src/ask-tool";

export default function askExtension(pi: ExtensionAPI) {
	registerAskTool(pi);
}
