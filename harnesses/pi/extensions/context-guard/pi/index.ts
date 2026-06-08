/**
 * Pi-specific path/settings helpers.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolvePiConfigDir } from "../util/pi-config.js";

export interface DiagnosticResult {
	check: string;
	status: "pass" | "fail" | "warn";
	message: string;
	fix?: string;
}

export const PI_NAME = "Pi";
const EXEC_COMMAND_WRAP_FLAG = Symbol.for("agents.context-guard.exec-wrap-enabled");

export function markExecCommandContextGuardEnabled(): void {
	(globalThis as Record<symbol, unknown>)[EXEC_COMMAND_WRAP_FLAG] = true;
}

export function isExecCommandContextGuardEnabled(): boolean {
	return (globalThis as Record<symbol, unknown>)[EXEC_COMMAND_WRAP_FLAG] === true;
}

export function resetExecCommandContextGuardEnabled(): void {
	delete (globalThis as Record<symbol, unknown>)[EXEC_COMMAND_WRAP_FLAG];
}

function getPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const envDir = env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", ".");
		if (envDir.startsWith("~/")) {
			return resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", envDir.slice(2));
		}
		return resolve(envDir);
	}
	return resolve(getPiConfigDir(env), "agent");
}

export function getPiConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolvePiConfigDir(env);
}

export function getPiSessionDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = join(getPiConfigDir(env), "context-guard", "sessions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function getPiSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(getPiConfigDir(env), "settings.json");
}

export function readPiSettings(): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(getPiSettingsPath(), "utf-8"));
	} catch {
		return null;
	}
}

export function writePiSettings(settings: Record<string, unknown>): void {
	const settingsPath = getPiSettingsPath();
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

export function checkPiExtensionRegistration(): DiagnosticResult {
	const settingsPath = resolve(getPiAgentDir(), "settings.json");
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const extensions = Array.isArray(settings?.extensions) ? settings.extensions : [];
		if (extensions.includes("extensions/context-guard/index.ts")) {
			return {
				check: "Pi extension registration",
				status: "pass",
				message: `context-guard extension enabled in ${settingsPath}`,
			};
		}
		return {
			check: "Pi extension registration",
			status: "warn",
			message: `context-guard extension missing from ${settingsPath}`,
		};
	} catch {
		return {
			check: "Pi extension registration",
			status: "fail",
			message: `Pi agent settings not found at ${settingsPath}`,
			fix: "Add extensions/context-guard/index.ts to pi/agent/settings.json or set PI_CODING_AGENT_DIR.",
		};
	}
}
