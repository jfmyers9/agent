import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVccCommand } from "./src/commands/vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerRecallTool } from "./src/tools/recall";

export default (pi: ExtensionAPI) => {
	scaffoldSettings();
	registerBeforeCompactHook(pi);
	registerVccCommand(pi);
	registerVccRecallCommand(pi);
	registerRecallTool(pi);
};
