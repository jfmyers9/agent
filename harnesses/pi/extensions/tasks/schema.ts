/// <reference path="./ambient.d.ts" />
import { randomBytes } from "node:crypto";

export const taskStatuses = [
	"open",
	"todo",
	"in_progress",
	"in_review",
	"rejected",
	"done",
	"canceled",
] as const;

export const taskTypes = ["epic", "feature", "bug", "chore"] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type TaskType = (typeof taskTypes)[number];

export interface TaskRecord {
	id: string;
	title: string;
	body: string;
	status: TaskStatus;
	type: TaskType;
	priority: number;
	labels: string[];
	assigned_to?: string | null;
	assigned_label?: string | null;
	epic_id?: string | null;
	epic_title?: string | null;
	parent_id?: string | null;
	blocked_by: string[];
	source_blueprint?: string | null;
	created_at: number;
	updated_at: number;
}

export interface TaskFile {
	version: 1;
	tasks: TaskRecord[];
}

export type TaskCommand =
	| "add"
	| "list"
	| "show"
	| "update"
	| "delete"
	| "accept"
	| "reject"
	| "import_blueprint"
	| "export_blueprint";

export interface TaskDetails {
	action: TaskCommand;
	task?: TaskRecord;
	tasks?: TaskRecord[];
	deleted?: string;
	message?: string;
	error?: string;
}

const idAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const statusSet = new Set<string>(taskStatuses);
const typeSet = new Set<string>(taskTypes);

export function nowMs(): number {
	return Date.now();
}

export function newTaskId(existing: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < 32; attempt++) {
		const bytes = randomBytes(6);
		let id = "";
		for (let i = 0; i < 6; i++) id += idAlphabet[bytes[i] % idAlphabet.length];
		id = id.toUpperCase();
		if (!existing.has(id)) return id;
	}
	throw new Error("could not generate unique task id");
}

export function normalizeStatus(
	value: unknown,
	fallback: TaskStatus = "open",
): TaskStatus {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	const normalized = value.trim() as TaskStatus;
	if (!statusSet.has(normalized)) {
		throw new Error(
			`invalid task status '${value}'. Expected one of: ${taskStatuses.join(", ")}`,
		);
	}
	return normalized;
}

export function normalizeType(
	value: unknown,
	fallback: TaskType = "chore",
): TaskType {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	const normalized = value.trim() as TaskType;
	if (!typeSet.has(normalized)) {
		throw new Error(
			`invalid task type '${value}'. Expected one of: ${taskTypes.join(", ")}`,
		);
	}
	return normalized;
}

export function normalizeTitle(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error("task title is required");
	const title = value.trim();
	if (title.length > 240)
		throw new Error("task title must be 240 characters or less");
	return title;
}

export function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

export function normalizeStringOrNull(
	value: unknown,
): string | null | undefined {
	if (value === null) return null;
	return normalizeString(value);
}

export function normalizeNumber(value: unknown, fallback = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.trunc(value);
}

export function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

export function isComplete(task: TaskRecord): boolean {
	return task.status === "done";
}

export function isCanceled(task: TaskRecord): boolean {
	return task.status === "canceled";
}

export function isActive(task: TaskRecord): boolean {
	return !isComplete(task) && !isCanceled(task);
}

export function hasReviewLifecycle(task: TaskRecord): boolean {
	return task.type === "feature" || task.type === "bug";
}

export function nextStatus(task: TaskRecord): TaskStatus {
	if (hasReviewLifecycle(task)) {
		if (task.status === "in_progress") return "in_review";
		if (task.status === "in_review") return "open";
		if (task.status === "rejected") return "in_progress";
		return "in_progress";
	}
	if (task.status === "in_progress") return "done";
	if (task.status === "done") return "open";
	return "in_progress";
}

export function doneStatus(task: TaskRecord): TaskStatus {
	return hasReviewLifecycle(task) ? "in_review" : "done";
}
