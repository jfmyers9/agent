/// <reference path="./ambient.d.ts" />
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	isActive,
	newTaskId,
	normalizeNumber,
	normalizeStatus,
	normalizeString,
	normalizeStringList,
	normalizeStringOrNull,
	normalizeTitle,
	normalizeType,
	nowMs,
	type TaskFile,
	type TaskRecord,
	type TaskStatus,
} from "./schema";

export interface TaskFilters {
	status?: string;
	type?: string;
	label?: string;
	epic_id?: string;
	assigned_to?: string;
	source_blueprint?: string;
	all?: boolean;
}

export interface AddTaskInput {
	title: unknown;
	body?: unknown;
	status?: unknown;
	type?: unknown;
	priority?: unknown;
	labels?: unknown;
	assigned_to?: unknown;
	assigned_label?: unknown;
	epic_id?: unknown;
	epic_title?: unknown;
	parent_id?: unknown;
	blocked_by?: unknown;
	source_blueprint?: unknown;
}

export interface UpdateTaskInput {
	id: unknown;
	title?: unknown;
	body?: unknown;
	status?: unknown;
	type?: unknown;
	priority?: unknown;
	labels?: unknown;
	assigned_to?: unknown;
	assigned_label?: unknown;
	clear_assignee?: unknown;
	epic_id?: unknown;
	epic_title?: unknown;
	clear_epic?: unknown;
	parent_id?: unknown;
	clear_parent?: unknown;
	blocked_by?: unknown;
	clear_blockers?: unknown;
	source_blueprint?: unknown;
	clear_source_blueprint?: unknown;
}

let mutationQueue = Promise.resolve();

function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
	const next = mutationQueue.then(fn, fn);
	mutationQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

function homePath(...parts: string[]): string {
	return join(process.env.HOME ?? process.cwd(), ...parts);
}

function safeProjectFallback(cwd: string): string {
	return basename(resolve(cwd)).replace(/[^a-zA-Z0-9_.-]+/g, "-") || "project";
}

export function projectName(cwd: string): string {
	try {
		return execFileSync("blueprint", ["project"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return safeProjectFallback(cwd);
	}
}

export function defaultTaskStorePath(cwd: string): string {
	const blueprintRoot =
		process.env.BLUEPRINT_DIR ?? homePath("workspace", "blueprints");
	return join(blueprintRoot, projectName(cwd), "tasks", "tasks.json");
}

function emptyFile(): TaskFile {
	return { version: 1, tasks: [] };
}

function assertTaskFile(value: unknown): TaskFile {
	if (!value || typeof value !== "object") return emptyFile();
	const tasks = Array.isArray((value as { tasks?: unknown }).tasks)
		? (value as { tasks: unknown[] }).tasks
		: [];
	return {
		version: 1,
		tasks: tasks
			.map(coerceTask)
			.filter((task): task is TaskRecord => Boolean(task)),
	};
}

function coerceTask(value: unknown): TaskRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Partial<TaskRecord> & Record<string, unknown>;
	try {
		const now = nowMs();
		return {
			id:
				typeof input.id === "string" && input.id.trim()
					? input.id.trim().toUpperCase()
					: newTaskId(new Set()),
			title: normalizeTitle(input.title),
			body: typeof input.body === "string" ? input.body : "",
			status: normalizeStatus(input.status),
			type: normalizeType(input.type),
			priority: normalizeNumber(input.priority),
			labels: normalizeStringList(input.labels),
			assigned_to: input.assigned_to ?? null,
			assigned_label: input.assigned_label ?? null,
			epic_id: input.epic_id ?? null,
			epic_title: input.epic_title ?? null,
			parent_id: input.parent_id ?? null,
			blocked_by: normalizeStringList(input.blocked_by),
			source_blueprint: input.source_blueprint ?? null,
			created_at: typeof input.created_at === "number" ? input.created_at : now,
			updated_at: typeof input.updated_at === "number" ? input.updated_at : now,
		};
	} catch {
		return undefined;
	}
}

export class TaskStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	static forCwd(cwd: string): TaskStore {
		return new TaskStore(defaultTaskStorePath(cwd));
	}

	async load(): Promise<TaskFile> {
		if (!existsSync(this.path)) return emptyFile();
		try {
			return assertTaskFile(JSON.parse(await readFile(this.path, "utf8")));
		} catch {
			return emptyFile();
		}
	}

	private async save(file: TaskFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
		await rename(tmp, this.path);
	}

	private async mutate<T>(fn: (file: TaskFile) => T | Promise<T>): Promise<T> {
		return enqueueMutation(async () => {
			const file = await this.load();
			const result = await fn(file);
			await this.save(file);
			return result;
		});
	}

	async list(filters: TaskFilters = {}): Promise<TaskRecord[]> {
		const file = await this.load();
		return sortTasks(
			file.tasks.filter((task) => matchesFilters(task, filters)),
		);
	}

	async show(idOrPrefix: string): Promise<TaskRecord> {
		const file = await this.load();
		return resolveTask(file.tasks, idOrPrefix);
	}

	async add(input: AddTaskInput): Promise<TaskRecord> {
		return this.mutate((file) => {
			const now = nowMs();
			const task: TaskRecord = {
				id: newTaskId(new Set(file.tasks.map((item) => item.id))),
				title: normalizeTitle(input.title),
				body: typeof input.body === "string" ? input.body : "",
				status: normalizeStatus(input.status),
				type: normalizeType(input.type),
				priority: normalizeNumber(input.priority),
				labels: normalizeStringList(input.labels),
				assigned_to: normalizeStringOrNull(input.assigned_to) ?? null,
				assigned_label: normalizeStringOrNull(input.assigned_label) ?? null,
				epic_id: normalizeStringOrNull(input.epic_id) ?? null,
				epic_title: normalizeStringOrNull(input.epic_title) ?? null,
				parent_id: normalizeStringOrNull(input.parent_id) ?? null,
				blocked_by: normalizeStringList(input.blocked_by),
				source_blueprint: normalizeStringOrNull(input.source_blueprint) ?? null,
				created_at: now,
				updated_at: now,
			};
			validateReferences(file.tasks, task);
			file.tasks.push(task);
			return task;
		});
	}

	async update(input: UpdateTaskInput): Promise<TaskRecord> {
		const id = normalizeString(input.id);
		if (!id) throw new Error("task id is required");
		return this.mutate((file) => {
			const task = resolveTask(file.tasks, id);
			if (input.title !== undefined) task.title = normalizeTitle(input.title);
			if (input.body !== undefined)
				task.body = typeof input.body === "string" ? input.body : "";
			if (input.status !== undefined)
				task.status = normalizeStatus(input.status);
			if (input.type !== undefined) task.type = normalizeType(input.type);
			if (input.priority !== undefined)
				task.priority = normalizeNumber(input.priority, task.priority);
			if (input.labels !== undefined)
				task.labels = normalizeStringList(input.labels);
			if (input.clear_assignee === true) {
				task.assigned_to = null;
				task.assigned_label = null;
			}
			if (input.assigned_to !== undefined)
				task.assigned_to = normalizeStringOrNull(input.assigned_to) ?? null;
			if (input.assigned_label !== undefined)
				task.assigned_label =
					normalizeStringOrNull(input.assigned_label) ?? null;
			if (input.clear_epic === true) {
				task.epic_id = null;
				task.epic_title = null;
			}
			if (input.epic_id !== undefined)
				task.epic_id = normalizeStringOrNull(input.epic_id) ?? null;
			if (input.epic_title !== undefined)
				task.epic_title = normalizeStringOrNull(input.epic_title) ?? null;
			if (input.clear_parent === true) task.parent_id = null;
			if (input.parent_id !== undefined)
				task.parent_id = normalizeStringOrNull(input.parent_id) ?? null;
			if (input.clear_blockers === true) task.blocked_by = [];
			if (input.blocked_by !== undefined)
				task.blocked_by = normalizeStringList(input.blocked_by);
			if (input.clear_source_blueprint === true) task.source_blueprint = null;
			if (input.source_blueprint !== undefined)
				task.source_blueprint =
					normalizeStringOrNull(input.source_blueprint) ?? null;
			task.updated_at = nowMs();
			validateReferences(file.tasks, task);
			return task;
		});
	}

	async delete(idOrPrefix: string): Promise<string> {
		return this.mutate((file) => {
			const task = resolveTask(file.tasks, idOrPrefix);
			if (
				file.tasks.some(
					(candidate) =>
						candidate.parent_id === task.id ||
						candidate.blocked_by.includes(task.id),
				)
			) {
				throw new Error(`cannot delete ${task.id}; other tasks reference it`);
			}
			file.tasks = file.tasks.filter((item) => item.id !== task.id);
			return task.id;
		});
	}

	async accept(idOrPrefix: string): Promise<TaskRecord> {
		return this.update({ id: idOrPrefix, status: "done" satisfies TaskStatus });
	}

	async reject(idOrPrefix: string, note: string): Promise<TaskRecord> {
		const cleanNote = normalizeString(note);
		if (!cleanNote) throw new Error("rejection note is required");
		const task = await this.show(idOrPrefix);
		const body = [task.body.trim(), `Rejected: ${cleanNote}`]
			.filter(Boolean)
			.join("\n\n");
		return this.update({ id: idOrPrefix, status: "rejected", body });
	}

	async addMany(
		inputs: AddTaskInput[],
		dedupe: (existing: TaskRecord, input: AddTaskInput) => boolean,
	): Promise<TaskRecord[]> {
		return this.mutate((file) => {
			const created: TaskRecord[] = [];
			for (const input of inputs) {
				if (file.tasks.some((task) => dedupe(task, input))) continue;
				const now = nowMs();
				const task: TaskRecord = {
					id: newTaskId(new Set(file.tasks.map((item) => item.id))),
					title: normalizeTitle(input.title),
					body: typeof input.body === "string" ? input.body : "",
					status: normalizeStatus(input.status),
					type: normalizeType(input.type),
					priority: normalizeNumber(input.priority),
					labels: normalizeStringList(input.labels),
					assigned_to: normalizeStringOrNull(input.assigned_to) ?? null,
					assigned_label: normalizeStringOrNull(input.assigned_label) ?? null,
					epic_id: normalizeStringOrNull(input.epic_id) ?? null,
					epic_title: normalizeStringOrNull(input.epic_title) ?? null,
					parent_id: normalizeStringOrNull(input.parent_id) ?? null,
					blocked_by: normalizeStringList(input.blocked_by),
					source_blueprint:
						normalizeStringOrNull(input.source_blueprint) ?? null,
					created_at: now,
					updated_at: now,
				};
				validateReferences(file.tasks, task);
				file.tasks.push(task);
				created.push(task);
			}
			return created;
		});
	}
}

function resolveTask(tasks: TaskRecord[], idOrPrefix: string): TaskRecord {
	const needle = idOrPrefix.trim().toUpperCase();
	if (!needle) throw new Error("task id is required");
	const matches = tasks.filter((task) =>
		task.id.toUpperCase().startsWith(needle),
	);
	if (matches.length === 0) throw new Error(`no task matches '${idOrPrefix}'`);
	if (matches.length > 1)
		throw new Error(
			`task id '${idOrPrefix}' is ambiguous: ${matches.map((task) => task.id).join(", ")}`,
		);
	return matches[0];
}

function matchesFilters(task: TaskRecord, filters: TaskFilters): boolean {
	if (!filters.all && !isActive(task)) return false;
	if (filters.status && task.status !== filters.status) return false;
	if (filters.type && task.type !== filters.type) return false;
	if (filters.label && !task.labels.includes(filters.label)) return false;
	if (filters.epic_id && task.epic_id !== filters.epic_id) return false;
	if (filters.assigned_to && task.assigned_to !== filters.assigned_to)
		return false;
	if (
		filters.source_blueprint &&
		task.source_blueprint !== filters.source_blueprint
	)
		return false;
	return true;
}

export function sortTasks(tasks: TaskRecord[]): TaskRecord[] {
	return [...tasks].sort((left, right) => {
		if (right.priority !== left.priority) return right.priority - left.priority;
		if (right.updated_at !== left.updated_at)
			return right.updated_at - left.updated_at;
		return left.title.localeCompare(right.title);
	});
}

function validateReferences(tasks: TaskRecord[], task: TaskRecord): void {
	const ids = new Set(tasks.map((item) => item.id));
	if (task.parent_id && !ids.has(task.parent_id))
		throw new Error(`parent task '${task.parent_id}' does not exist`);
	for (const blocker of task.blocked_by) {
		if (!ids.has(blocker))
			throw new Error(`blocker task '${blocker}' does not exist`);
		if (blocker === task.id) throw new Error("task cannot block itself");
	}
}

export function taskStoreDirectory(cwd: string): string {
	return dirname(defaultTaskStorePath(cwd));
}
