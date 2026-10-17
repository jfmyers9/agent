import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ModelRef, Tier } from "./types.js";

export interface RoutingSettings {
	version: 1;
	classifier: ModelRef;
	tiers: Record<Tier, ModelRef>;
	subagents: boolean;
	timeoutMs: number;
	maxTokens: number;
}

export const ROUTING_PROVIDER = "routing";
export const ROUTING_MODEL = "auto";
export const TIERS: readonly Tier[] = ["luna", "sol", "astra"];
export const modelName = (model: ModelRef) => `${model.provider}/${model.id}`;
export const isModelRef = (value: unknown): value is ModelRef => {
	if (!value || typeof value !== "object") return false;
	const model = value as ModelRef;
	return (
		typeof model.provider === "string" &&
		!!model.provider &&
		model.provider.trim() === model.provider &&
		!model.provider.includes("/") &&
		typeof model.id === "string" &&
		!!model.id &&
		model.id.trim() === model.id
	);
};

export function validSettings(value: unknown): value is RoutingSettings {
	if (!value || typeof value !== "object") return false;
	const settings = value as RoutingSettings;
	return (
		settings.version === 1 &&
		isModelRef(settings.classifier) &&
		!!settings.tiers &&
		TIERS.every((tier) => isModelRef(settings.tiers[tier])) &&
		typeof settings.subagents === "boolean" &&
		Number.isInteger(settings.timeoutMs) &&
		settings.timeoutMs >= 1000 &&
		settings.timeoutMs <= 30_000 &&
		Number.isInteger(settings.maxTokens) &&
		settings.maxTokens >= 128 &&
		settings.maxTokens <= 4096
	);
}

export function routingSettingsPath(): string {
	const root = process.env.XDG_STATE_HOME;
	return join(
		root && isAbsolute(root) ? root : join(homedir(), ".local", "state"),
		"agent-routing",
		"preferences.json",
	);
}

/** Personal, application-managed preferences. No repository config or default-model edits. */
export class RoutingSettingsStore {
	constructor(readonly path = routingSettingsPath()) {}
	async load(): Promise<RoutingSettings | undefined> {
		let source: string;
		try {
			source = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch {
			throw new Error("Routing preferences are invalid. Use /routing setup to replace them.");
		}
		if (!validSettings(value))
			throw new Error("Routing preferences are incompatible. Use /routing setup to replace them.");
		return value;
	}
	async save(settings: RoutingSettings): Promise<void> {
		if (!validSettings(settings)) throw new Error("Invalid routing preferences.");
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, this.path);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
}
