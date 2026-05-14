/// <reference path="./ambient.d.ts" />
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isActive, isCanceled, isComplete, type TaskRecord } from "./schema";
import { sortTasks } from "./store";

export interface TaskBoardColumn {
	id: "rejected" | "ready" | "blocked" | "in_progress" | "in_review" | "done";
	label: string;
	tasks: TaskRecord[];
}

export interface TaskBoardSelection {
	column: number;
	row: number;
}

export interface RenderDisplayContext {
	currentAssignee?: string;
	hideKanban?: boolean;
	maxTasks?: number;
	worktreeLabel?: string;
	showWorktree?: boolean;
}

function byId(tasks: TaskRecord[]): Map<string, TaskRecord> {
	return new Map(tasks.map((task) => [task.id, task]));
}

export function taskChildren(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
	const children = new Map<string, TaskRecord[]>();
	for (const task of tasks) {
		if (!task.parent_id) continue;
		const list = children.get(task.parent_id) ?? [];
		list.push(task);
		children.set(task.parent_id, list);
	}
	return children;
}

export function unresolvedDependencies(
	task: TaskRecord,
	tasks: TaskRecord[],
): TaskRecord[] {
	const lookup = byId(tasks);
	const children = taskChildren(tasks);
	const blockers = task.blocked_by.flatMap((id) => {
		const blocker = lookup.get(id);
		return blocker && !isComplete(blocker) && !isCanceled(blocker)
			? [blocker]
			: [];
	});
	const activeChildren = (children.get(task.id) ?? []).filter(isActive);
	return [...blockers, ...activeChildren];
}

function isBlocked(task: TaskRecord, tasks: TaskRecord[]): boolean {
	return unresolvedDependencies(task, tasks).length > 0;
}

export function buildTaskBoardColumns(tasks: TaskRecord[]): TaskBoardColumn[] {
	const active = tasks.filter(
		(task) => !isCanceled(task) && task.type !== "epic",
	);
	const ready = active.filter(
		(task) =>
			!isComplete(task) &&
			task.status !== "rejected" &&
			task.status !== "in_progress" &&
			task.status !== "in_review" &&
			!isBlocked(task, active),
	);
	const blocked = active.filter(
		(task) => !isComplete(task) && isBlocked(task, active),
	);
	const rejected = active.filter(
		(task) => task.status === "rejected" && !isBlocked(task, active),
	);
	const columns: TaskBoardColumn[] = [
		{ id: "ready", label: "Ready", tasks: sortTasks(ready) },
		{ id: "blocked", label: "Blocked", tasks: sortTasks(blocked) },
		{
			id: "in_progress",
			label: "In Progress",
			tasks: sortTasks(
				active.filter(
					(task) => task.status === "in_progress" && !isBlocked(task, active),
				),
			),
		},
		{
			id: "in_review",
			label: "In Review",
			tasks: sortTasks(
				active.filter(
					(task) => task.status === "in_review" && !isBlocked(task, active),
				),
			),
		},
		{ id: "done", label: "Done", tasks: sortTasks(active.filter(isComplete)) },
	];
	if (rejected.length > 0)
		columns.unshift({
			id: "rejected",
			label: "Rejected",
			tasks: sortTasks(rejected),
		});
	return columns;
}

export function clampSelection(
	columns: TaskBoardColumn[],
	selection: TaskBoardSelection,
): TaskBoardSelection {
	if (columns.length === 0) return { column: 0, row: 0 };
	const column = Math.max(0, Math.min(columns.length - 1, selection.column));
	const rowCount = columns[column]?.tasks.length ?? 0;
	const row = Math.max(0, Math.min(Math.max(0, rowCount - 1), selection.row));
	return { column, row };
}

export function selectedTask(
	columns: TaskBoardColumn[],
	selection: TaskBoardSelection,
): TaskRecord | undefined {
	const safe = clampSelection(columns, selection);
	return columns[safe.column]?.tasks[safe.row];
}

function truncate(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "…");
}

function pad(text: string, width: number): string {
	const out = truncate(text, width);
	return out + " ".repeat(Math.max(0, width - visibleWidth(out)));
}

function splitWidths(width: number, count: number): number[] {
	const gap = Math.max(0, count - 1) * 2;
	const available = Math.max(count, width - gap);
	const base = Math.floor(available / count);
	let extra = available % count;
	return Array.from({ length: count }, () => base + (extra-- > 0 ? 1 : 0));
}

function statusIcon(task: TaskRecord, theme: Theme): string {
	switch (task.status) {
		case "done":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "▶");
		case "in_review":
			return theme.fg("warning", "◉");
		case "rejected":
			return theme.fg("error", "✕");
		default:
			return theme.fg("dim", "○");
	}
}

function taskLine(
	task: TaskRecord,
	theme: Theme,
	width: number,
	selected: boolean,
	currentAssignee?: string,
	showWorktree = false,
): string {
	const assigned =
		currentAssignee && task.assigned_to === currentAssignee
			? theme.fg("accent", " @me")
			: "";
	const priority = task.priority ? theme.fg("muted", ` p${task.priority}`) : "";
	const source = task.source_blueprint ? theme.fg("dim", " ↗") : "";
	const lane = showWorktree
		? theme.fg("dim", ` [${task.worktree_label ?? task.worktree_key ?? "project"}]`)
		: "";
	const prefix = selected ? theme.fg("accent", "›") : " ";
	return truncate(
		`${prefix} ${statusIcon(task, theme)} ${theme.fg("accent", task.id)} ${task.title}${lane}${assigned}${priority}${source}`,
		width,
	);
}

function renderColumn(
	column: TaskBoardColumn,
	width: number,
	height: number,
	theme: Theme,
	selected: number,
	currentAssignee?: string,
	showWorktree = false,
): string[] {
	const lines = [
		theme.fg("mdHeading", `${column.label} (${column.tasks.length})`),
	];
	const visible = column.tasks.slice(0, Math.max(0, height - 1));
	for (let i = 0; i < visible.length; i++) {
		lines.push(
			taskLine(
				visible[i],
				theme,
				width,
				i === selected,
				currentAssignee,
				showWorktree,
			),
		);
	}
	while (lines.length < height) lines.push("");
	return lines.map((line) => pad(line, width));
}

function formatDate(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "unknown";
	return new Date(ms).toLocaleString();
}

export function renderTaskDetails(
	task: TaskRecord | undefined,
	allTasks: TaskRecord[],
	theme: Theme,
	width: number,
): string[] {
	if (!task) return [theme.fg("dim", "No task selected")];
	const deps = unresolvedDependencies(task, allTasks);
	const children = (taskChildren(allTasks).get(task.id) ?? []).map(
		(child) => `${child.id} ${child.title}`,
	);
	const lines = [
		theme.fg("mdHeading", `${task.id} ${task.title}`),
		`${theme.fg("muted", "Status:")} ${task.status}  ${theme.fg("muted", "Type:")} ${task.type}  ${theme.fg("muted", "Priority:")} ${task.priority}`,
	];
	if (task.assigned_label || task.assigned_to)
		lines.push(
			`${theme.fg("muted", "Assigned:")} ${task.assigned_label ?? task.assigned_to}`,
		);
	if (task.epic_id)
		lines.push(
			`${theme.fg("muted", "Epic:")} ${task.epic_title ? `${task.epic_title} (${task.epic_id})` : task.epic_id}`,
		);
	if (task.source_blueprint)
		lines.push(`${theme.fg("muted", "Blueprint:")} ${task.source_blueprint}`);
	if (task.worktree_label || task.worktree_key)
		lines.push(
			`${theme.fg("muted", "Worktree:")} ${task.worktree_label ?? task.worktree_key}`,
		);
	if (task.labels.length > 0)
		lines.push(`${theme.fg("muted", "Labels:")} ${task.labels.join(", ")}`);
	if (deps.length > 0)
		lines.push(
			`${theme.fg("warning", "Blocked by:")} ${deps.map((dep) => `${dep.id} ${dep.title}`).join(", ")}`,
		);
	if (children.length > 0)
		lines.push(`${theme.fg("muted", "Children:")} ${children.join(", ")}`);
	if (task.body.trim()) lines.push("", ...task.body.trim().split("\n"));
	lines.push("", theme.fg("dim", `Updated ${formatDate(task.updated_at)}`));
	return lines.map((line) => truncate(line, width));
}

export function renderTaskBoardLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	selection: TaskBoardSelection = { column: 0, row: 0 },
	display: RenderDisplayContext = {},
): string[] {
	const safeWidth = Math.max(40, width);
	const columns = buildTaskBoardColumns(tasks);
	const selected = clampSelection(columns, selection);
	const boardWidth = Math.max(24, Math.floor(safeWidth * 0.64));
	const detailWidth = Math.max(16, safeWidth - boardWidth - 3);
	const widths = splitWidths(boardWidth, columns.length || 1);
	const height = 10;
	const renderedColumns = columns.length
		? columns.map((column, index) =>
				renderColumn(
					column,
					widths[index],
					height,
					theme,
					index === selected.column ? selected.row : -1,
					display.currentAssignee,
					display.showWorktree,
				),
			)
		: [[theme.fg("dim", "No tasks")]];
	const lines = [
		truncate(
			`${theme.fg("mdHeading", "╭ Tasks")} ${theme.fg("dim", "space status · a assign · d done · x cancel · +/- priority · r reload · esc close")}`,
			safeWidth,
		),
	];
	for (let row = 0; row < height; row++) {
		const left = renderedColumns
			.map((column, index) =>
				pad(column[row] ?? "", widths[index] ?? boardWidth),
			)
			.join("  ");
		const detail =
			renderTaskDetails(
				selectedTask(columns, selected),
				tasks,
				theme,
				detailWidth,
			)[row] ?? "";
		lines.push(
			`${pad(left, boardWidth)} ${theme.fg("borderMuted", "│")} ${pad(detail, detailWidth)}`,
		);
	}
	lines.push(
		truncate(
			theme.fg("borderMuted", "╰" + "─".repeat(Math.max(0, safeWidth - 1))),
			safeWidth,
		),
	);
	return lines.map((line) => truncate(line, safeWidth));
}

function summaryParts(columns: TaskBoardColumn[]): string[] {
	return columns
		.filter((column) => column.tasks.length > 0)
		.map((column) => `${column.label.toLowerCase()}: ${column.tasks.length}`);
}

export function renderHudLines(
	tasks: TaskRecord[],
	theme: Theme,
	width: number,
	display: RenderDisplayContext = {},
): string[] {
	const safeWidth = Math.max(20, width);
	const columns = buildTaskBoardColumns(
		tasks.filter((task) => !isCanceled(task)),
	);
	const activeCount = tasks.filter(
		(task) =>
			!isCanceled(task) &&
			(!isComplete(task) || task.assigned_to === display.currentAssignee),
	).length;
	if (activeCount === 0) return [];
	const parts = summaryParts(columns);
	const lane = display.worktreeLabel
		? theme.fg("dim", ` ${display.worktreeLabel}`)
		: "";
	const header = truncate(
		`${theme.fg("mdHeading", "●")} ${theme.fg("mdHeading", `${activeCount} tasks`)}${lane} ${theme.fg("muted", `(${parts.join(", ") || "all clear"})`)}`,
		safeWidth,
	);
	if (display.hideKanban) return [header];
	const maxTasks = display.maxTasks ?? 6;
	const lines = [header];
	for (const column of columns.filter((item) => item.tasks.length > 0)) {
		lines.push(
			truncate(
				theme.fg("borderMuted", `─ ${column.label} `) +
					theme.fg(
						"borderMuted",
						"─".repeat(Math.max(0, safeWidth - column.label.length - 3)),
					),
				safeWidth,
			),
		);
		for (const task of column.tasks.slice(0, maxTasks)) {
			lines.push(
				taskLine(
					task,
					theme,
					safeWidth,
					false,
					display.currentAssignee,
					display.showWorktree,
				),
			);
		}
	}
	return lines.map((line) => truncate(line, safeWidth));
}

export function formatTaskList(tasks: TaskRecord[]): string {
	if (tasks.length === 0) return "No tasks";
	return tasks
		.map((task) => {
			const lane = task.worktree_label ? ` [${task.worktree_label}]` : "";
			return `${task.id} [${task.status}] (${task.type})${lane} ${task.title}`;
		})
		.join("\n");
}
