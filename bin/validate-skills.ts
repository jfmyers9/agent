#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const PORTABLE_TOOLS = new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
const FRONTMATTER_KEYS = new Set([
	"name",
	"description",
	"license",
	"allowed-tools",
	"argument-hint",
	"user-invocable",
	"disable-model-invocation",
	"metadata",
]);
const SHELL_VARIABLES = new Set(["branch", "file", "status"]);

export type SkillIssue = {
	file: string;
	message: string;
};

function frontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new Error("missing or malformed YAML frontmatter");
	const parsed = Bun.YAML.parse(match[1]);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("frontmatter must be a mapping");
	}
	return parsed as Record<string, unknown>;
}

function toolNames(value: unknown): string[] | null {
	if (typeof value === "string")
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
	return null;
}

function discoveredSkillNames(root: string): Set<string> {
	const skillsDir = join(root, "skills");
	if (!existsSync(skillsDir)) return new Set();
	return new Set(
		readdirSync(skillsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
			.map((entry) => entry.name),
	);
}

export function validateSkillFile(file: string, root: string, skillNames = discoveredSkillNames(root)): SkillIssue[] {
	const issues: SkillIssue[] = [];
	const content = readFileSync(file, "utf8");
	let metadata: Record<string, unknown>;

	try {
		metadata = frontmatter(content);
	} catch (error) {
		return [{ file, message: error instanceof Error ? error.message : String(error) }];
	}

	for (const key of Object.keys(metadata)) {
		if (!FRONTMATTER_KEYS.has(key)) issues.push({ file, message: `unsupported frontmatter key: ${key}` });
	}

	const directory = basename(dirname(file));
	if (metadata.name !== directory) issues.push({ file, message: `name must match directory: ${directory}` });
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(directory)) {
		issues.push({ file, message: "skill directory must use lowercase kebab-case" });
	}
	if (typeof metadata.description !== "string" || metadata.description.trim().length < 20) {
		issues.push({ file, message: "description must be a specific nonempty string" });
	}
	if (metadata["argument-hint"] !== undefined && typeof metadata["argument-hint"] !== "string") {
		issues.push({ file, message: "argument-hint must be a string" });
	}
	if (metadata.license !== undefined && typeof metadata.license !== "string") {
		issues.push({ file, message: "license must be a string" });
	}
	if (
		metadata.metadata !== undefined &&
		(typeof metadata.metadata !== "object" || metadata.metadata === null || Array.isArray(metadata.metadata))
	) {
		issues.push({ file, message: "metadata must be a mapping" });
	}

	const tools = toolNames(metadata["allowed-tools"]);
	if (!tools) {
		issues.push({ file, message: "allowed-tools must be a comma-separated string or string list" });
	} else {
		for (const tool of tools) {
			if (!PORTABLE_TOOLS.has(tool)) issues.push({ file, message: `non-portable allowed tool: ${tool}` });
		}
	}

	const disabled = metadata["disable-model-invocation"];
	const invocable = metadata["user-invocable"];
	if (disabled !== undefined && typeof disabled !== "boolean") {
		issues.push({ file, message: "disable-model-invocation must be boolean" });
	}
	if (invocable !== undefined && typeof invocable !== "boolean") {
		issues.push({ file, message: "user-invocable must be boolean" });
	}
	if (disabled === true && invocable !== true) {
		issues.push({ file, message: "hidden skills must remain user-invocable" });
	}

	if (/blueprint create\s+(?:spec|plan)\b/.test(content)) {
		issues.push({ file, message: "must not create retired spec or plan artifacts" });
	}
	if (/blueprint create\b/.test(content) && (disabled !== true || invocable !== true)) {
		issues.push({ file, message: "artifact-producing skills must be explicit-only" });
	}

	for (const match of content.matchAll(/@rules\/([A-Za-z0-9_.-]+\.md)/g)) {
		const target = resolve(root, "rules", match[1]);
		if (!existsSync(target)) issues.push({ file, message: `missing rule reference: @rules/${match[1]}` });
	}
	for (const match of content.matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g)) {
		const target = resolve(root, "skills", match[1], "SKILL.md");
		if (!existsSync(target)) issues.push({ file, message: `missing skill reference: ${match[0]}` });
	}
	for (const match of content.matchAll(/\/skill:([a-z][a-z0-9-]*)/g)) {
		if (!skillNames.has(match[1])) issues.push({ file, message: `missing skill invocation: /skill:${match[1]}` });
	}
	for (const match of content.matchAll(/\$([A-Za-z_][A-Za-z0-9_-]*)/g)) {
		const name = match[1];
		if (name !== name.toLowerCase() || name.includes("_") || SHELL_VARIABLES.has(name)) continue;
		if (!skillNames.has(name)) issues.push({ file, message: `missing skill invocation: $${name}` });
	}

	content.split(/\r?\n/).forEach((line, index) => {
		if (line.length > 100) issues.push({ file, message: `line ${index + 1} exceeds 100 characters` });
	});

	return issues;
}

export function validateSkills(root: string): SkillIssue[] {
	const skillsDir = join(root, "skills");
	const skillNames = discoveredSkillNames(root);
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
		.flatMap((entry) => validateSkillFile(join(skillsDir, entry.name, "SKILL.md"), root, skillNames));
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const issues = validateSkills(root);
	if (issues.length === 0) {
		console.log("skills: ok");
	} else {
		for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);
		process.exitCode = 1;
	}
}
