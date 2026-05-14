/// <reference path="./ambient.d.ts" />
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey } from "@earendil-works/pi-tui";
import { doneStatus, nextStatus, type TaskRecord } from "./schema";
import {
	buildTaskBoardColumns,
	clampSelection,
	renderTaskBoardLines,
	selectedTask,
	type TaskBoardSelection,
} from "./render";

export interface TaskBoardOptions {
	tasks: TaskRecord[];
	theme: Theme;
	currentAssignee?: string;
	showWorktree?: boolean;
	worktreeLabel?: string;
	onClose: () => void;
	onReload: () => Promise<TaskRecord[]>;
	onMutate: (
		action: "update" | "delete",
		params: Record<string, unknown>,
	) => Promise<TaskRecord[]>;
	onChange?: () => void;
}

function isKey(data: string, key: string): boolean {
	return (
		data === key || (key === "space" && data === " ") || matchesKey(data, key)
	);
}

function isAnyKey(data: string, keys: string[]): boolean {
	return keys.some((key) => isKey(data, key));
}

export class TaskBoardOverlay implements Component {
	private tasks: TaskRecord[];
	private selectionState: TaskBoardSelection = { column: 0, row: 0 };
	private pending?: Promise<void>;
	private confirmingDelete?: string;
	private errorMessage?: string;

	constructor(private readonly options: TaskBoardOptions) {
		this.tasks = options.tasks;
		this.selectionState = clampSelection(
			buildTaskBoardColumns(this.tasks),
			this.selectionState,
		);
	}

	selection(): TaskBoardSelection {
		return { ...this.selectionState };
	}

	waitForIdle(): Promise<void> {
		return this.pending ?? Promise.resolve();
	}

	invalidate(): void {}

	private setSelection(next: TaskBoardSelection): void {
		this.selectionState = clampSelection(
			buildTaskBoardColumns(this.tasks),
			next,
		);
		this.options.onChange?.();
	}

	private currentTask(): TaskRecord | undefined {
		return selectedTask(buildTaskBoardColumns(this.tasks), this.selectionState);
	}

	private moveColumn(delta: number): void {
		this.setSelection({
			column: this.selectionState.column + delta,
			row: this.selectionState.row,
		});
	}

	private moveRow(delta: number): void {
		this.setSelection({
			column: this.selectionState.column,
			row: this.selectionState.row + delta,
		});
	}

	private preserveSelection(taskId?: string): void {
		const columns = buildTaskBoardColumns(this.tasks);
		if (taskId) {
			for (let column = 0; column < columns.length; column++) {
				const row = columns[column].tasks.findIndex(
					(task) => task.id === taskId,
				);
				if (row >= 0) {
					this.selectionState = { column, row };
					return;
				}
			}
		}
		this.selectionState = clampSelection(columns, this.selectionState);
	}

	private runMutation(
		action: "update" | "delete",
		params: Record<string, unknown>,
	): void {
		const currentId = action === "delete" ? undefined : this.currentTask()?.id;
		this.errorMessage = undefined;
		this.pending = this.options
			.onMutate(action, params)
			.then((tasks) => {
				this.tasks = tasks;
				this.preserveSelection(currentId);
			})
			.catch((error) => {
				this.errorMessage =
					error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.pending = undefined;
				this.confirmingDelete = undefined;
				this.options.onChange?.();
			});
		this.options.onChange?.();
	}

	private updateSelected(params: Record<string, unknown>): void {
		const task = this.currentTask();
		if (!task) return;
		this.runMutation("update", { id: task.id, ...params });
	}

	private reload(): void {
		const currentId = this.currentTask()?.id;
		this.errorMessage = undefined;
		this.pending = this.options
			.onReload()
			.then((tasks) => {
				this.tasks = tasks;
				this.preserveSelection(currentId);
			})
			.catch((error) => {
				this.errorMessage =
					error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.pending = undefined;
				this.options.onChange?.();
			});
		this.options.onChange?.();
	}

	handleInput(data: string): void {
		if (this.confirmingDelete) {
			if (isAnyKey(data, ["y", "Y", "enter"])) {
				this.runMutation("delete", { id: this.confirmingDelete });
				return;
			}
			if (isAnyKey(data, ["n", "N", "escape"])) {
				this.confirmingDelete = undefined;
				this.options.onChange?.();
				return;
			}
		}
		if (isAnyKey(data, ["escape", "ctrl+c"])) {
			this.options.onClose();
			return;
		}
		if (isAnyKey(data, ["left", "h"])) return this.moveColumn(-1);
		if (isAnyKey(data, ["right", "l"])) return this.moveColumn(1);
		if (isAnyKey(data, ["up", "k"])) return this.moveRow(-1);
		if (isAnyKey(data, ["down", "j"])) return this.moveRow(1);
		if (this.pending) return;
		if (isAnyKey(data, ["space"])) {
			const task = this.currentTask();
			if (task) this.updateSelected({ status: nextStatus(task) });
			return;
		}
		if (data === "a") return this.updateSelected({ assigned_to: "current" });
		if (data === "u") return this.updateSelected({ clear_assignee: true });
		if (data === "+") {
			const task = this.currentTask();
			if (task) this.updateSelected({ priority: task.priority + 1 });
			return;
		}
		if (data === "-") {
			const task = this.currentTask();
			if (task) this.updateSelected({ priority: task.priority - 1 });
			return;
		}
		if (data === "d") {
			const task = this.currentTask();
			if (task) this.updateSelected({ status: doneStatus(task) });
			return;
		}
		if (data === "x") return this.updateSelected({ status: "canceled" });
		if (data === "D") {
			const task = this.currentTask();
			if (task) {
				this.confirmingDelete = task.id;
				this.options.onChange?.();
			}
			return;
		}
		if (data === "r") return this.reload();
	}

	render(width: number): string[] {
		const lines = renderTaskBoardLines(
			this.tasks,
			this.options.theme,
			width,
			this.selectionState,
			{
				currentAssignee: this.options.currentAssignee,
				showWorktree: this.options.showWorktree,
				worktreeLabel: this.options.worktreeLabel,
			},
		);
		if (this.confirmingDelete) {
			lines.push(
				this.options.theme.fg(
					"warning",
					`Delete ${this.confirmingDelete}? y/n`,
				),
			);
		}
		if (this.pending)
			lines.push(this.options.theme.fg("dim", "Updating tasks…"));
		if (this.errorMessage)
			lines.push(this.options.theme.fg("error", this.errorMessage));
		return lines;
	}
}
