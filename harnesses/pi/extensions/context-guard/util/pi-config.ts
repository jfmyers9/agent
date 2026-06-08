import { homedir } from "node:os";
import { resolve } from "node:path";

export function resolvePiConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	const envVal = env.PI_CONFIG_DIR;
	if (envVal && envVal.trim() !== "") {
		if (envVal.startsWith("~")) {
			return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
		}
		return resolve(envVal);
	}
	return resolve(homedir(), ".pi");
}

export function resolvePiGlobalSettingsPaths(env: NodeJS.ProcessEnv = process.env): string[] {
	return [resolve(resolvePiConfigDir(env), "settings.json")];
}
