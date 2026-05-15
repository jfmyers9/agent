import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const SKILL_PREFIX = "skill:";
export const SKILLFUL_CUSTOM_TYPE = "skillful-load";
export const SKILLFUL_CACHE_EVENT = "skillful:cache";

export type SkillfulLoadStatus = "read" | "cached";

export type SkillfulLoadDetails = {
	extension: "skillful";
	kind: "skill-load";
	name: string;
	status: SkillfulLoadStatus;
	filePath?: string;
	baseDir?: string;
	loads?: SkillfulLoadDetails[];
};

export function collectSkills(pi: ExtensionAPI): Map<string, string> {
	const out = new Map<string, string>();
	for (const cmd of pi.getCommands()) {
		if (cmd.source !== "skill" || !cmd.name.startsWith(SKILL_PREFIX)) continue;
		const name = cmd.name.slice(SKILL_PREFIX.length).trim();
		const path = cmd.sourceInfo?.path;
		if (!name || !path || out.has(name)) continue;
		out.set(name, path);
	}
	return out;
}

export function buildItems(skills: Map<string, string>): AutocompleteItem[] {
	return [...skills.keys()].map((name) => ({
		value: `$${name}`,
		label: `$${name}`,
		description: "skill",
	}));
}

export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	const after = text.indexOf("\n", end + 4);
	return after === -1 ? "" : text.slice(after + 1);
}

export function rewriteSlashSkillReferences(text: string, skills: Iterable<string>): string {
	const names = [...skills].filter(Boolean).sort((a, b) => b.length - a.length);
	if (names.length === 0 || !text.includes("/")) return text;
	const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`(?<![\\w$~.])\\/(${escaped.join("|")})(?=(?:\\s|\`|[.,;:)<]|$))`, "g");
	return text.replace(pattern, (_match, name: string) => `$${name}`);
}

export function skillBaseDir(filePath: string): string {
	return dirname(filePath);
}

export function loadedDetails(
	name: string,
	status: SkillfulLoadStatus,
	filePath?: string,
	baseDir?: string,
): SkillfulLoadDetails {
	return {
		extension: "skillful",
		kind: "skill-load",
		name,
		status,
		filePath,
		baseDir,
	};
}

export function formatReadSkillContent(name: string, filePath: string, body: string): string {
	const baseDir = skillBaseDir(filePath);
	return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

export function formatCachedSkillContent(name: string): string {
	return `Skill "${name}" is already loaded in this session branch. Continue following its instructions.`;
}

export function isSkillfulLoadDetails(value: unknown): value is SkillfulLoadDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<SkillfulLoadDetails>;
	return details.extension === "skillful" && details.kind === "skill-load" && typeof details.name === "string";
}

export function reconstructLoadedSkills(entries: unknown[]): Set<string> {
	const branch = entries.filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>;
	let lastCompactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index]?.type === "compaction") {
			lastCompactionIndex = index;
			break;
		}
	}
	const loaded = new Set<string>();
	for (const entry of branch.slice(lastCompactionIndex + 1)) {
		for (const details of extractLoadDetails(entry)) {
			if (details.status === "read") loaded.add(details.name);
		}
	}
	return loaded;
}

function extractLoadDetails(entry: Record<string, unknown>): SkillfulLoadDetails[] {
	if (entry.type === "custom_message" && entry.customType === SKILLFUL_CUSTOM_TYPE) {
		return flattenLoadDetails(entry.details);
	}
	if (entry.type !== "message") return [];
	const message = entry.message;
	if (!message || typeof message !== "object") return [];
	const msg = message as Record<string, unknown>;
	if (msg.role !== "toolResult" || msg.toolName !== "skill") return [];
	return flattenLoadDetails(msg.details);
}

function flattenLoadDetails(value: unknown): SkillfulLoadDetails[] {
	if (!isSkillfulLoadDetails(value)) return [];
	const loads = Array.isArray(value.loads) ? value.loads.filter(isSkillfulLoadDetails) : [];
	return loads.length > 0 ? loads : [value];
}
