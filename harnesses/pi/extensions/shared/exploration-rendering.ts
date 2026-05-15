import { basename } from "node:path";

export type ExplorationStatus = "running" | "done";

export type ExplorationAction =
	| { kind: "read"; title?: string; body: string; path?: string }
	| { kind: "find" | "search" | "list" | "run"; title: string; body: string };

export interface ExplorationRenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

interface ExplorationEntry {
	toolCallId: string;
	action: ExplorationAction;
	status: ExplorationStatus;
	hidden: boolean;
	groupId?: number;
	invalidate?: () => void;
}

interface ExplorationGroup {
	id: number;
	entryIds: string[];
	visibleEntryId: string;
}

export interface ExplorationRenderInfo {
	hidden: boolean;
	status: ExplorationStatus;
	actionGroups?: ExplorationAction[][];
}

type ArgsToAction = (args: unknown) => ExplorationAction | undefined;
type PiWithEvents = {
	on?: (event: string, handler: (event: any) => void) => void;
};

const actionByToolName = new Map<string, ArgsToAction>();
const registeredPis = new WeakSet<object>();

const entriesByToolCallId = new Map<string, ExplorationEntry>();
const groupsById = new Map<number, ExplorationGroup>();
let activeExplorationGroupId: number | undefined;
let nextGroupId = 1;

export function readAction(filePath: string | undefined): ExplorationAction {
	const path = filePath ?? "";
	return { kind: "read", body: basename(path) || path || "file", path };
}

export function registerExplorationTool(toolName: string, toAction: ArgsToAction): void {
	actionByToolName.set(toolName, toAction);
}

export function registerExplorationEventHandlers(pi: PiWithEvents): void {
	if (!pi.on || registeredPis.has(pi)) return;
	registeredPis.add(pi);

	pi.on("session_start", clearExplorationGroup);
	pi.on("session_tree", clearExplorationGroup);
	pi.on("session_shutdown", clearExplorationGroup);
	pi.on("message_start", (event) => {
		if (event.message?.role === "toolResult") return;
		if (isToolCallOnlyAssistantMessage(event.message)) return;
		resetExplorationGroup();
	});
	pi.on("tool_execution_start", (event) => {
		const toAction = actionByToolName.get(event.toolName);
		if (!toAction) {
			resetExplorationGroup();
			return;
		}
		const action = toAction(event.args);
		if (action) recordExplorationStart(event.toolCallId, action);
	});
	pi.on("tool_execution_end", (event) => {
		if (actionByToolName.has(event.toolName)) recordExplorationEnd(event.toolCallId);
	});
}

export function registerExplorationRenderContext(
	toolCallId: string | undefined,
	invalidate: (() => void) | undefined,
): void {
	if (!toolCallId) return;
	const entry = entriesByToolCallId.get(toolCallId);
	if (!entry) return;
	entry.invalidate = invalidate;
}

export function getExplorationRenderInfo(
	toolCallId: string | undefined,
	fallbackStatus: ExplorationStatus,
): ExplorationRenderInfo {
	if (!toolCallId) return { hidden: false, status: fallbackStatus };
	const entry = entriesByToolCallId.get(toolCallId);
	if (!entry) return { hidden: false, status: fallbackStatus };
	if (entry.hidden) return { hidden: true, status: entry.status };

	const group = getGroupForEntry(entry);
	if (!group) {
		return {
			hidden: false,
			status: entry.status,
			actionGroups: [[entry.action]],
		};
	}

	const entries = group.entryIds
		.map((entryId) => entriesByToolCallId.get(entryId))
		.filter((groupEntry): groupEntry is ExplorationEntry => Boolean(groupEntry));
	return {
		hidden: false,
		status: entries.some((groupEntry) => groupEntry.status === "running") ? "running" : "done",
		actionGroups: entries.map((groupEntry) => [groupEntry.action]),
	};
}

export function renderExplorationText(
	actionGroups: ExplorationAction[][],
	status: ExplorationStatus,
	theme: ExplorationRenderTheme,
	failed = false,
): string {
	const header = status === "running" ? "Exploring" : "Explored";
	let text = `${renderStatusMarker("•", status, theme, failed)} ${theme.bold(header)}`;

	for (const [index, action] of coalesceReadActions(actionGroups.flat()).entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		const title = action.kind === "read" ? "Read" : action.title;
		text += `\n${theme.fg("dim", prefix)}${theme.fg("accent", title)} ${theme.fg("muted", action.body)}`;
	}

	return text;
}

export function renderExplorationCall(
	action: ExplorationAction,
	theme: ExplorationRenderTheme,
	context:
		| {
				toolCallId?: string;
				invalidate?: () => void;
				isPartial?: boolean;
				isError?: boolean;
		  }
		| undefined,
): string {
	registerExplorationRenderContext(context?.toolCallId, context?.invalidate);
	const fallbackStatus = context?.isPartial === false ? "done" : "running";
	const renderInfo = getExplorationRenderInfo(context?.toolCallId, fallbackStatus);
	if (renderInfo.hidden) return "";
	return renderExplorationText(
		renderInfo.actionGroups ?? [[action]],
		renderInfo.status,
		theme,
		context?.isError === true,
	);
}

export function isExplorationHidden(toolCallId: string | undefined): boolean {
	return getExplorationRenderInfo(toolCallId, "done").hidden;
}

function recordExplorationStart(toolCallId: string, action: ExplorationAction): void {
	const entry: ExplorationEntry = {
		toolCallId,
		action,
		status: "running",
		hidden: false,
	};
	entriesByToolCallId.set(toolCallId, entry);

	let group = activeExplorationGroupId ? groupsById.get(activeExplorationGroupId) : undefined;
	if (!group) {
		group = {
			id: nextGroupId++,
			entryIds: [toolCallId],
			visibleEntryId: toolCallId,
		};
		groupsById.set(group.id, group);
		activeExplorationGroupId = group.id;
		entry.groupId = group.id;
		return;
	}

	const previousVisibleEntry = entriesByToolCallId.get(group.visibleEntryId);
	if (previousVisibleEntry) {
		previousVisibleEntry.hidden = true;
		previousVisibleEntry.invalidate?.();
	}

	group.entryIds.push(toolCallId);
	group.visibleEntryId = toolCallId;
	entry.groupId = group.id;
}

function recordExplorationEnd(toolCallId: string): void {
	const entry = entriesByToolCallId.get(toolCallId);
	if (!entry) return;
	entry.status = "done";
	const group = getGroupForEntry(entry);
	entriesByToolCallId.get(group?.visibleEntryId ?? toolCallId)?.invalidate?.();
}

function resetExplorationGroup(): void {
	activeExplorationGroupId = undefined;
}

function clearExplorationGroup(): void {
	entriesByToolCallId.clear();
	groupsById.clear();
	activeExplorationGroupId = undefined;
	nextGroupId = 1;
}

function getGroupForEntry(entry: ExplorationEntry | undefined): ExplorationGroup | undefined {
	if (!entry?.groupId) return undefined;
	return groupsById.get(entry.groupId);
}

function renderStatusMarker(
	marker: string,
	status: ExplorationStatus,
	theme: Pick<ExplorationRenderTheme, "fg">,
	failed: boolean,
): string {
	if (status === "running") return theme.fg("dim", marker);
	return theme.fg(failed ? "error" : "success", marker);
}

function coalesceReadActions(actions: ExplorationAction[]): ExplorationAction[] {
	const coalesced: ExplorationAction[] = [];
	for (let index = 0; index < actions.length; index += 1) {
		const action = actions[index];
		if (action.kind !== "read") {
			coalesced.push(action);
			continue;
		}

		const reads: Extract<ExplorationAction, { kind: "read" }>[] = [];
		const seenPaths = new Set<string>();
		for (let readIndex = index; readIndex < actions.length; readIndex += 1) {
			const read = actions[readIndex];
			if (read.kind !== "read") break;
			const key = read.path ?? read.body;
			if (!seenPaths.has(key)) {
				reads.push(read);
				seenPaths.add(key);
			}
			index = readIndex;
		}

		const duplicateBodies = new Set<string>();
		const seenBodies = new Set<string>();
		for (const read of reads) {
			if (seenBodies.has(read.body)) duplicateBodies.add(read.body);
			seenBodies.add(read.body);
		}
		coalesced.push({
			kind: "read",
			body: reads.map((read) => (duplicateBodies.has(read.body) ? (read.path ?? read.body) : read.body)).join(", "),
			path: reads.at(-1)?.path,
		});
	}
	return coalesced;
}

function isToolCallOnlyAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return false;
	if (!("content" in message) || !Array.isArray(message.content) || message.content.length === 0) return false;
	return message.content.every(
		(item) => typeof item === "object" && item !== null && "type" in item && item.type === "toolCall",
	);
}
