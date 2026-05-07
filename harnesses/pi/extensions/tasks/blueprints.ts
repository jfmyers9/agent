/// <reference path="./ambient.d.ts" />
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { normalizeString, type TaskRecord } from "./schema";
import type { AddTaskInput } from "./store";

export interface BlueprintImportResult {
	blueprintPath: string;
	slug: string;
	inputs: AddTaskInput[];
}

function slugFromPath(path: string): string {
	return basename(path).replace(/\.md$/, "");
}

export function resolveBlueprint(cwd: string, match?: string): string {
	if (match && existsSync(match)) return match;
	const args = ["find", "--type", "plan,spec,review"];
	if (match?.trim()) args.push("--match", match.trim());
	const out = execFileSync("blueprint", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)[0];
	if (!out)
		throw new Error(
			match ? `no blueprint matches '${match}'` : "no blueprint found",
		);
	return out;
}

function stripFrontmatter(markdown: string): string {
	if (!markdown.startsWith("---\n")) return markdown;
	const end = markdown.indexOf("\n---\n", 4);
	return end >= 0 ? markdown.slice(end + 5) : markdown;
}

function sectionAfter(markdown: string, heading: string): string {
	const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im");
	const match = markdown.match(pattern);
	if (!match || match.index === undefined) return markdown;
	const start = match.index + match[0].length;
	const rest = markdown.slice(start);
	const next = rest.search(/^##\s+/m);
	return next >= 0 ? rest.slice(0, next) : rest;
}

function cleanStepTitle(text: string): string {
	return text
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 180);
}

export function parseBlueprintTasks(
	markdown: string,
	slug: string,
): AddTaskInput[] {
	const body = sectionAfter(stripFrontmatter(markdown), "Plan");
	const lines = body.split("\n");
	const inputs: AddTaskInput[] = [];
	let phaseTitle = "Plan";
	let phaseIndex = 0;
	let stepIndex = 0;

	for (const line of lines) {
		const phase =
			line.match(/^\*\*Phase\s+(\d+)\s*:\s*(.+?)\*\*\s*$/i) ??
			line.match(/^#{2,3}\s+Phase\s+(\d+)\s*:\s*(.+?)\s*$/i);
		if (phase) {
			phaseIndex = Number(phase[1]);
			phaseTitle = cleanStepTitle(phase[2]);
			stepIndex = 0;
			inputs.push({
				title: `Phase ${phaseIndex}: ${phaseTitle}`,
				body: `Imported from blueprint ${slug}`,
				type: "epic",
				status: "open",
				priority: 100 - phaseIndex,
				epic_id: slug,
				epic_title: phaseTitle,
				source_blueprint: slug,
				labels: ["blueprint"],
			});
			continue;
		}
		const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
		if (!numbered) continue;
		const title = cleanStepTitle(numbered[1]);
		if (!title || title.length < 4) continue;
		stepIndex++;
		inputs.push({
			title,
			body: `Phase ${phaseIndex || "?"}: ${phaseTitle}`,
			type: "chore",
			status: "open",
			priority: Math.max(0, 50 - stepIndex),
			epic_id: slug,
			epic_title: phaseTitle,
			source_blueprint: slug,
			labels: ["blueprint-step"],
		});
	}

	if (inputs.length > 0) return inputs;
	const bullets = body
		.split("\n")
		.map((line) => line.match(/^\s*-\s+(.+)$/)?.[1])
		.filter((value): value is string => Boolean(value))
		.map(cleanStepTitle)
		.filter((title) => title.length >= 4)
		.slice(0, 20);
	return bullets.map((title, index) => ({
		title,
		body: `Imported from blueprint ${slug}`,
		type: "chore",
		status: "open",
		priority: Math.max(0, 50 - index),
		epic_id: slug,
		epic_title: "Blueprint",
		source_blueprint: slug,
		labels: ["blueprint-step"],
	}));
}

export function buildBlueprintImport(
	cwd: string,
	match?: string,
): BlueprintImportResult {
	const blueprintPath = resolveBlueprint(cwd, match);
	const slug = slugFromPath(blueprintPath);
	const markdown = readFileSync(blueprintPath, "utf8");
	return { blueprintPath, slug, inputs: parseBlueprintTasks(markdown, slug) };
}

export function dedupeBlueprintTask(
	existing: TaskRecord,
	input: AddTaskInput,
): boolean {
	const source = normalizeString(input.source_blueprint);
	const title = normalizeString(input.title);
	return Boolean(
		source &&
			title &&
			existing.source_blueprint === source &&
			existing.title === title,
	);
}

export function summarizeBlueprintTasks(
	tasks: TaskRecord[],
	sourceBlueprint: string,
): string {
	const linked = tasks.filter(
		(task) => task.source_blueprint === sourceBlueprint,
	);
	if (linked.length === 0) return `No tasks linked to ${sourceBlueprint}.`;
	const done = linked.filter((task) => task.status === "done").length;
	const active = linked.filter(
		(task) => task.status !== "done" && task.status !== "canceled",
	).length;
	const canceled = linked.filter((task) => task.status === "canceled").length;
	const lines = [
		`Task summary for ${sourceBlueprint}: ${done}/${linked.length} done, ${active} active, ${canceled} canceled`,
		"",
	];
	for (const task of linked)
		lines.push(
			`- [${task.status === "done" ? "x" : " "}] ${task.id} ${task.title} (${task.status})`,
		);
	return lines.join("\n");
}
