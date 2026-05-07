/// <reference path="./ambient.d.ts" />
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isActive, type TaskRecord } from "./schema";
import { TaskStore } from "./store";
import { taskChildren, unresolvedDependencies } from "./render";

export interface TaskGuardConfig {
	enabled: boolean;
}

interface GuardState {
	lastFingerprint?: string;
	lastProgressSerial?: number;
	progressSerial: number;
	pausedTurns: number;
	lastUserText?: string;
	pending?: GuardDecision;
}

interface GuardDecision {
	fingerprint: string;
	content: string;
}

export function sessionAssignment(ctx?: ExtensionContext): string | undefined {
	const file = ctx?.sessionManager?.getSessionFile?.();
	if (typeof file === "string" && file.trim()) {
		return `session:${file
			.split(/[\\/]/)
			.pop()
			?.replace(/\.jsonl?$/, "")}`;
	}
	return undefined;
}

export function sessionLabel(pi?: ExtensionAPI): string | undefined {
	try {
		const label = pi?.getSessionName?.();
		return typeof label === "string" && label.trim() ? label.trim() : undefined;
	} catch {
		return undefined;
	}
}

function pausesGuard(text: string): boolean {
	return /\b(pause|stop|hold|disable)\s+(the\s+)?task guard\b|\btask guard\s+(pause|stop|off|disable)\b/i.test(
		text,
	);
}

function messageText(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((item) =>
			item && typeof item === "object" && "text" in item
				? String((item as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

function messageHasToolCall(message: { content?: unknown }): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.some(
			(item) =>
				item &&
				typeof item === "object" &&
				(item as { type?: string }).type === "toolCall",
		)
	);
}

function chooseNextTask(
	tasks: TaskRecord[],
	assignee: string,
): TaskRecord | undefined {
	const assigned = tasks.filter(
		(task) => task.assigned_to === assignee && isActive(task),
	);
	const inProgress = assigned.find(
		(task) =>
			task.status === "in_progress" &&
			unresolvedDependencies(task, tasks).length === 0,
	);
	if (inProgress) return inProgress;
	const readyAssigned = assigned.find(
		(task) =>
			task.status !== "in_review" &&
			unresolvedDependencies(task, tasks).length === 0 &&
			(taskChildren(tasks).get(task.id)?.length ?? 0) === 0,
	);
	if (readyAssigned) return readyAssigned;
	const epics = new Set(
		assigned
			.map((task) => task.epic_id)
			.filter((value): value is string => Boolean(value)),
	);
	return tasks.find(
		(task) =>
			!task.assigned_to &&
			task.epic_id &&
			epics.has(task.epic_id) &&
			isActive(task) &&
			unresolvedDependencies(task, tasks).length === 0,
	);
}

async function evaluate(
	ctx: ExtensionContext,
	state: GuardState,
): Promise<GuardDecision | undefined> {
	const assignee = sessionAssignment(ctx);
	if (!assignee) return undefined;
	const tasks = await TaskStore.forCwd(ctx.cwd).list({ all: true });
	const task = chooseNextTask(tasks, assignee);
	if (!task) return undefined;
	const fingerprint = `${task.id}:${task.status}:${task.updated_at}:${state.progressSerial}`;
	const stalled =
		state.lastFingerprint === fingerprint &&
		state.lastProgressSerial === state.progressSerial;
	const start = task.assigned_to === assignee ? "Continue" : "Claim";
	const content = stalled
		? `Task guard stalled. Work remains: ${task.id} [${task.status}] ${task.title}. Continue now or pause task guard.`
		: `Task guard: ${start} task ${task.id}: ${task.title}. Do not summarize or stop; continue this task now.`;
	return { fingerprint, content };
}

export function installTaskGuard(
	pi: ExtensionAPI,
	config: TaskGuardConfig,
): void {
	if (!config.enabled) return;
	const state: GuardState = { progressSerial: 0, pausedTurns: 0 };

	pi.on("tool_execution_end", () => {
		state.progressSerial++;
	});

	pi.on("message_end", async (event, ctx) => {
		const message = (
			event as { message?: { role?: string; content?: unknown } }
		).message;
		if (message?.role === "user") {
			const text = messageText(message);
			state.lastUserText = text;
			if (pausesGuard(text)) state.pausedTurns = 1;
			return undefined;
		}
		if (
			message?.role !== "assistant" ||
			messageHasToolCall(message) ||
			!messageText(message).trim()
		)
			return undefined;
		if (state.pausedTurns > 0) {
			state.pausedTurns--;
			state.pending = undefined;
			return undefined;
		}
		try {
			state.pending = await evaluate(ctx, state);
		} catch (error) {
			state.pending = undefined;
			ctx.ui.notify?.(
				`Task guard failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		return undefined;
	});

	pi.on("turn_end", async () => {
		const decision = state.pending;
		state.pending = undefined;
		if (!decision) return;
		state.lastFingerprint = decision.fingerprint;
		state.lastProgressSerial = state.progressSerial;
		pi.sendMessage?.(
			{ customType: "task-guard", content: decision.content, display: false },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
