import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const SKILL_PREFIX = "skill:";

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
