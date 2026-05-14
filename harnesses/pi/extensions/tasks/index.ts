/// <reference path="./ambient.d.ts" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TaskBoardOverlay } from "./board";
import {
	buildBlueprintImport,
	dedupeBlueprintTask,
	summarizeBlueprintTasks,
} from "./blueprints";
import { installTaskGuard, sessionAssignment, sessionLabel } from "./guard";
import {
	taskScopes,
	taskStatuses,
	taskTypes,
	type TaskCommand,
	type TaskDetails,
	type TaskRecord,
	type TaskScope,
} from "./schema";
import { formatTaskList, renderHudLines } from "./render";
import {
	TaskStore,
	worktreeIdentity,
	type AddTaskInput,
	type UpdateTaskInput,
} from "./store";

interface Config {
	enabled: boolean;
	store: "blueprints";
	hud: {
		enabled: boolean;
		maxTasks: number;
		minTerminalRows: number;
		toggleShortcut: string;
	};
	guard: {
		enabled: boolean;
	};
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(extensionDir, "config.json");

const defaultConfig: Config = {
	enabled: true,
	store: "blueprints",
	hud: {
		enabled: true,
		maxTasks: 6,
		minTerminalRows: 24,
		toggleShortcut: "alt+t",
	},
	guard: { enabled: false },
};

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(
			readFileSync(configPath, "utf8"),
		) as Partial<Config>;
		return {
			...defaultConfig,
			...parsed,
			hud: { ...defaultConfig.hud, ...parsed.hud },
			guard: { ...defaultConfig.guard, ...parsed.guard },
		};
	} catch {
		return defaultConfig;
	}
}

function enoughRows(config: Config): boolean {
	const rows = process.stdout.rows;
	return typeof rows !== "number" || rows >= config.hud.minTerminalRows;
}

function terminalWidth(): number {
	return typeof process.stdout.columns === "number"
		? process.stdout.columns
		: 100;
}

function store(ctx: ExtensionContext): TaskStore {
	return TaskStore.forCwd(ctx.cwd);
}

function normalizeCurrentAssignment(
	params: Record<string, unknown>,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Record<string, unknown> {
	if (params.assigned_to !== "current") return params;
	const assignedTo = sessionAssignment(ctx);
	if (!assignedTo) return params;
	return {
		...params,
		assigned_to: assignedTo,
		assigned_label: sessionLabel(pi) ?? assignedTo.replace(/^session:/, ""),
	};
}

function textResult(text: string, details: TaskDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function renderTaskSummary(task: TaskRecord): string {
	const lane = task.worktree_label ? ` [${task.worktree_label}]` : "";
	return `${task.id} [${task.status}] (${task.type})${lane} ${task.title}`;
}

function requestScope(params: Record<string, unknown>): TaskScope {
	if (params.scope === "all_worktrees" || params.all_worktrees === true)
		return "all_worktrees";
	if (params.scope === "project") return "project";
	if (params.scope === "legacy") return "legacy";
	return "current";
}

function formatToolResult(details: TaskDetails): string {
	if (details.error) return `Error: ${details.error}`;
	if (details.deleted) return `Deleted ${details.deleted}`;
	if (details.task) return renderTaskSummary(details.task);
	if (details.tasks) return formatTaskList(details.tasks);
	return details.message ?? "OK";
}

async function refreshHud(
	ctx: ExtensionContext,
	config: Config,
): Promise<void> {
	if (!config.hud.enabled || !enoughRows(config)) {
		ctx.ui.setWidget?.("project-tasks", undefined);
		return;
	}
	const tasks = await store(ctx).list({ all: true });
	const lines = renderHudLines(tasks, ctx.ui.theme, terminalWidth(), {
		currentAssignee: sessionAssignment(ctx),
		hideKanban: taskHudHidden,
		maxTasks: config.hud.maxTasks,
		worktreeLabel: worktreeIdentity(ctx.cwd).label,
	});
	ctx.ui.setWidget?.("project-tasks", lines.length > 0 ? lines : undefined, {
		placement: "aboveEditor",
	});
}

let taskHudHidden = false;

async function mutateAndRefresh<T>(
	ctx: ExtensionContext,
	config: Config,
	action: () => Promise<T>,
): Promise<T> {
	const result = await action();
	await refreshHud(ctx, config).catch(() => undefined);
	return result;
}

async function runAction(
	action: TaskCommand,
	params: Record<string, unknown>,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: Config,
) {
	const taskStore = store(ctx);
	switch (action) {
		case "add": {
			const task = await mutateAndRefresh(ctx, config, () =>
				taskStore.add(
					normalizeCurrentAssignment(
						params,
						pi,
						ctx,
					) as unknown as AddTaskInput,
				),
			);
			return textResult(`Added ${renderTaskSummary(task)}`, { action, task });
		}
		case "list": {
			const normalized = normalizeCurrentAssignment(params, pi, ctx);
			const tasks = await taskStore.list(normalized);
			return textResult(formatTaskList(tasks), { action, tasks });
		}
		case "show": {
			const task = await taskStore.show(String(params.id ?? ""), requestScope(params));
			return textResult(formatToolResult({ action, task }), { action, task });
		}
		case "update": {
			const task = await mutateAndRefresh(ctx, config, () =>
				taskStore.update(
					normalizeCurrentAssignment(
						params,
						pi,
						ctx,
					) as unknown as UpdateTaskInput,
				),
			);
			return textResult(`Updated ${renderTaskSummary(task)}`, { action, task });
		}
		case "delete": {
			const deleted = await mutateAndRefresh(ctx, config, () =>
				taskStore.delete(String(params.id ?? ""), requestScope(params)),
			);
			return textResult(`Deleted ${deleted}`, { action, deleted });
		}
		case "accept": {
			const task = await mutateAndRefresh(ctx, config, () =>
				taskStore.accept(String(params.id ?? ""), requestScope(params)),
			);
			return textResult(`Accepted ${renderTaskSummary(task)}`, {
				action,
				task,
			});
		}
		case "reject": {
			const task = await mutateAndRefresh(ctx, config, () =>
				taskStore.reject(
					String(params.id ?? ""),
					String(params.note ?? ""),
					requestScope(params),
				),
			);
			return textResult(`Rejected ${renderTaskSummary(task)}`, {
				action,
				task,
			});
		}
		case "import_blueprint": {
			const imported = buildBlueprintImport(
				ctx.cwd,
				typeof params.match === "string" ? params.match : undefined,
				worktreeIdentity(ctx.cwd),
			);
			const created = await mutateAndRefresh(ctx, config, () =>
				taskStore.addMany(imported.inputs, dedupeBlueprintTask),
			);
			return textResult(
				`Imported ${created.length} task(s) from ${imported.slug}`,
				{
					action,
					tasks: created,
					message: imported.blueprintPath,
				},
			);
		}
		case "export_blueprint": {
			const source = String(params.source_blueprint ?? params.match ?? "");
			const allWorktrees = requestScope(params) === "all_worktrees";
			const tasks = await taskStore.list({
				all: true,
				scope: allWorktrees ? "all_worktrees" : "current",
			});
			const summary = summarizeBlueprintTasks(tasks, source, allWorktrees);
			return textResult(summary, {
				action,
				tasks: tasks.filter((task) => task.source_blueprint === source),
				message: summary,
			});
		}
	}
}

function taskTool(action: TaskCommand, pi: ExtensionAPI, config: Config) {
	return {
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			return runAction(action, params, pi, ctx, config);
		},
		renderCall(
			args: Record<string, unknown>,
			theme: {
				fg: (role: string, text: string) => string;
				bold: (text: string) => string;
			},
		) {
			const id = args.id ? ` ${theme.fg("accent", String(args.id))}` : "";
			const title = args.title
				? ` ${theme.fg("dim", JSON.stringify(args.title))}`
				: "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`task_${action}`)) + id + title,
				0,
				0,
			);
		},
		renderResult(
			result: {
				details?: TaskDetails;
				content?: Array<{ type: string; text?: string }>;
			},
			_options: unknown,
			theme: { fg: (role: string, text: string) => string },
		) {
			const details = result.details;
			if (!details) return new Text(result.content?.[0]?.text ?? "", 0, 0);
			const text = formatToolResult(details);
			const color = details.error
				? "error"
				: details.action === "delete"
					? "warning"
					: "muted";
			return new Text(theme.fg(color, text), 0, 0);
		},
	};
}

const StatusParam = Type.Optional(StringEnum(taskStatuses));
const TypeParam = Type.Optional(StringEnum(taskTypes));
const ScopeParam = Type.Optional(StringEnum(taskScopes));

export default function tasksExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	if (!config.enabled) return;

	pi.on("session_start", async (_event, ctx) => {
		await refreshHud(ctx, config).catch((error) => {
			ctx.ui.notify?.(
				`Task HUD refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget?.("project-tasks", undefined);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		await refreshHud(ctx, config).catch(() => undefined);
	});

	pi.registerShortcut?.(config.hud.toggleShortcut, {
		description: "Toggle project task HUD detail",
		handler: async (ctx: ExtensionContext) => {
			taskHudHidden = !taskHudHidden;
			await refreshHud(ctx, config);
		},
	});

	pi.registerCommand("tasks", {
		description:
			"Open project task board; use /tasks blueprint [slug] to import blueprint steps",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const boardScope: TaskScope = parts[0] === "all" ? "all_worktrees" : "current";
			if (parts[0] === "blueprint") {
				const imported = await runAction(
					"import_blueprint",
					{ match: parts.slice(1).join(" ") },
					pi,
					ctx,
					config,
				);
				ctx.ui.notify?.(imported.content[0].text, "success");
				return;
			}
			if (parts[0] === "export") {
				const result = await runAction(
					"export_blueprint",
					{
						source_blueprint: parts[1],
						scope: parts.includes("all") ? "all_worktrees" : "current",
					},
					pi,
					ctx,
					config,
				);
				ctx.ui.notify?.(result.content[0].text, "info");
				return;
			}
			const taskStore = store(ctx);
			let handle: { requestRender?: () => void } | undefined;
			await ctx.ui.custom<void>(
				(_tui: unknown, theme, _keybindings: unknown, done: () => void) => {
					const board = new TaskBoardOverlay({
						tasks: [],
						theme,
						currentAssignee: sessionAssignment(ctx),
						showWorktree: boardScope === "all_worktrees",
						worktreeLabel: worktreeIdentity(ctx.cwd).label,
						onClose: () => done(),
						onReload: () => taskStore.list({ all: true, scope: boardScope }),
						onMutate: async (action, params) => {
							const scoped = { ...params, scope: boardScope };
							if (action === "delete")
								await taskStore.delete(String(params.id ?? ""), boardScope);
							else
								await taskStore.update(
									normalizeCurrentAssignment(
										scoped,
										pi,
										ctx,
									) as unknown as UpdateTaskInput,
								);
							await refreshHud(ctx, config).catch(() => undefined);
							return taskStore.list({ all: true, scope: boardScope });
						},
						onChange: () => handle?.requestRender?.(),
					});
					taskStore.list({ all: true, scope: boardScope }).then((tasks) => {
						(board as unknown as { tasks: TaskRecord[] }).tasks = tasks;
						handle?.requestRender?.();
					});
					return board;
				},
				{
					onHandle: (nextHandle: { requestRender?: () => void }) => {
						handle = nextHandle;
					},
				},
			);
		},
	});

	pi.registerCommand("accept", {
		description: "Accept an in-review task",
		handler: async (args: string, ctx: ExtensionContext) => {
			const id = args.trim();
			if (!id) return ctx.ui.notify?.("Usage: /accept <task-id>", "warning");
			const result = await runAction("accept", { id }, pi, ctx, config);
			ctx.ui.notify?.(result.content[0].text, "success");
		},
	});

	pi.registerCommand("reject", {
		description: "Reject an in-review task with a note",
		handler: async (args: string, ctx: ExtensionContext) => {
			const [id, ...noteParts] = args.trim().split(/\s+/).filter(Boolean);
			if (!id || noteParts.length === 0)
				return ctx.ui.notify?.("Usage: /reject <task-id> <note>", "warning");
			const result = await runAction(
				"reject",
				{ id, note: noteParts.join(" ") },
				pi,
				ctx,
				config,
			);
			ctx.ui.notify?.(result.content[0].text, "warning");
		},
	});

	pi.registerTool({
		...taskTool("add", pi, config),
		name: "task_add",
		label: "Add Task",
		description: "Create a persisted project task.",
		promptSnippet: "Create a persisted project task",
		parameters: Type.Object({
			title: Type.String({ description: "Task title" }),
			body: Type.Optional(Type.String({ description: "Task details/body" })),
			status: StatusParam,
			type: TypeParam,
			priority: Type.Optional(
				Type.Number({ description: "Priority; higher sorts first" }),
			),
			labels: Type.Optional(Type.Array(Type.String())),
			assigned_to: Type.Optional(
				Type.String({
					description: "Assignee, or 'current' for this Pi session",
				}),
			),
			epic_id: Type.Optional(Type.String()),
			epic_title: Type.Optional(Type.String()),
			parent_id: Type.Optional(Type.String()),
			blocked_by: Type.Optional(Type.Array(Type.String())),
			source_blueprint: Type.Optional(Type.String()),
			scope: ScopeParam,
		}),
	});

	pi.registerTool({
		...taskTool("list", pi, config),
		name: "task_list",
		label: "List Tasks",
		description: "List persisted project tasks.",
		promptSnippet: "List persisted project tasks",
		parameters: Type.Object({
			status: StatusParam,
			type: TypeParam,
			label: Type.Optional(Type.String()),
			epic_id: Type.Optional(Type.String()),
			assigned_to: Type.Optional(
				Type.String({ description: "Assignee, or 'current'" }),
			),
			source_blueprint: Type.Optional(Type.String()),
			scope: ScopeParam,
			all_worktrees: Type.Optional(Type.Boolean()),
			all: Type.Optional(
				Type.Boolean({ description: "Include done/canceled tasks" }),
			),
		}),
	});

	pi.registerTool({
		...taskTool("show", pi, config),
		name: "task_show",
		label: "Show Task",
		description: "Show one persisted project task by ID or unique prefix.",
		promptSnippet: "Show a persisted project task",
		parameters: Type.Object({
			id: Type.String(),
			scope: ScopeParam,
			all_worktrees: Type.Optional(Type.Boolean()),
		}),
	});

	pi.registerTool({
		...taskTool("update", pi, config),
		name: "task_update",
		label: "Update Task",
		description: "Update a persisted project task.",
		promptSnippet: "Update a persisted project task",
		parameters: Type.Object({
			id: Type.String(),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			status: StatusParam,
			type: TypeParam,
			priority: Type.Optional(Type.Number()),
			labels: Type.Optional(Type.Array(Type.String())),
			assigned_to: Type.Optional(
				Type.String({ description: "Assignee, or 'current'" }),
			),
			clear_assignee: Type.Optional(Type.Boolean()),
			epic_id: Type.Optional(Type.String()),
			epic_title: Type.Optional(Type.String()),
			clear_epic: Type.Optional(Type.Boolean()),
			parent_id: Type.Optional(Type.String()),
			clear_parent: Type.Optional(Type.Boolean()),
			blocked_by: Type.Optional(Type.Array(Type.String())),
			clear_blockers: Type.Optional(Type.Boolean()),
			source_blueprint: Type.Optional(Type.String()),
			clear_source_blueprint: Type.Optional(Type.Boolean()),
			scope: ScopeParam,
			all_worktrees: Type.Optional(Type.Boolean()),
		}),
	});

	pi.registerTool({
		...taskTool("delete", pi, config),
		name: "task_delete",
		label: "Delete Task",
		description: "Delete a persisted project task.",
		promptSnippet: "Delete a persisted project task",
		parameters: Type.Object({
			id: Type.String(),
			scope: ScopeParam,
			all_worktrees: Type.Optional(Type.Boolean()),
		}),
	});

	pi.registerTool({
		...taskTool("accept", pi, config),
		name: "task_accept",
		label: "Accept Task",
		description: "Accept an in-review task and mark it done.",
		promptSnippet: "Accept an in-review task",
		parameters: Type.Object({
			id: Type.String(),
			scope: ScopeParam,
			all_worktrees: Type.Optional(Type.Boolean()),
		}),
	});

	pi.registerTool({
		...taskTool("reject", pi, config),
		name: "task_reject",
		label: "Reject Task",
		description: "Reject an in-review task with a required note.",
		promptSnippet: "Reject an in-review task",
		parameters: Type.Object({
			id: Type.String(),
			note: Type.String(),
			scope: ScopeParam,
			all_worktrees: Type.Optional(Type.Boolean()),
		}),
	});

	pi.registerTool({
		...taskTool("import_blueprint", pi, config),
		name: "task_import_blueprint",
		label: "Import Blueprint Tasks",
		description: "Import blueprint plan steps into persisted project tasks.",
		promptSnippet: "Import blueprint plan steps into tasks",
		parameters: Type.Object({
			match: Type.Optional(
				Type.String({ description: "Blueprint slug/path/search term" }),
			),
		}),
	});

	pi.registerTool({
		...taskTool("export_blueprint", pi, config),
		name: "task_export_blueprint",
		label: "Export Blueprint Task Summary",
		description: "Summarize tasks linked to a blueprint slug.",
		promptSnippet: "Summarize blueprint-linked tasks",
		parameters: Type.Object({
			source_blueprint: Type.String({ description: "Blueprint slug" }),
			scope: ScopeParam,
			all_worktrees: Type.Optional(Type.Boolean()),
		}),
	});

	installTaskGuard(pi, config.guard);
}
