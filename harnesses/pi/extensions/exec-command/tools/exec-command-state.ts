import { type CommandSummary, type ShellAction, summarizeShellCommand } from "../shell/summary.ts";

export type ExecCommandStatus = "running" | "done";

export interface ExecCommandRenderInfo {
	hidden: boolean;
	status: ExecCommandStatus;
	actionGroups?: ShellAction[][];
	elapsedMs?: number;
	rtkWrapped?: boolean;
	contextGuardWrapped?: boolean;
	sessionId?: number;
}

interface ExecEntry {
	toolCallId: string;
	command: string;
	summary: CommandSummary;
	status: ExecCommandStatus;
	hidden: boolean;
	startedAtMs: number;
	rtkWrapped: boolean;
	contextGuardWrapped: boolean;
	sessionId?: number;
	groupId?: number;
	invalidate?: () => void;
}

interface ExecGroup {
	id: number;
	entryIds: string[];
	visibleEntryId: string;
}

export interface ExecCommandTracker {
	getState(command: string): ExecCommandStatus;
	getRenderInfo(toolCallId: string | undefined, command: string): ExecCommandRenderInfo;
	registerRenderContext(toolCallId: string | undefined, invalidate: () => void): void;
	ensurePlannedExploration(toolCallId: string | undefined, command: string): void;
	recordStart(toolCallId: string, command: string): void;
	recordRtkWrapped(toolCallId: string): void;
	recordContextGuardWrapped(toolCallId: string): void;
	recordPersistentSession(toolCallId: string, sessionId: number): void;
	recordEnd(toolCallId: string): void;
	recordSessionFinished(sessionId: number): void;
	resetExplorationGroup(): void;
	clear(): void;
}

export function createExecCommandTracker(): ExecCommandTracker {
	const commandByToolCallId = new Map<string, string>();
	const runningCountsByCommand = new Map<string, number>();
	const sessionBackedToolCallIds = new Set<string>();
	const contextGuardWrappedToolCallIds = new Set<string>();
	const toolCallIdBySessionId = new Map<number, string>();
	const entriesByToolCallId = new Map<string, ExecEntry>();
	const groupsById = new Map<number, ExecGroup>();
	let activeExplorationGroupId: number | undefined;
	let nextGroupId = 1;

	function incrementCommand(command: string): void {
		runningCountsByCommand.set(command, (runningCountsByCommand.get(command) ?? 0) + 1);
	}

	function decrementCommand(command: string): void {
		const next = (runningCountsByCommand.get(command) ?? 0) - 1;
		if (next > 0) {
			runningCountsByCommand.set(command, next);
			return;
		}
		runningCountsByCommand.delete(command);
	}

	function invalidateToolCall(toolCallId: string | undefined): void {
		if (!toolCallId) return;
		entriesByToolCallId.get(toolCallId)?.invalidate?.();
	}

	function getGroupForEntry(entry: ExecEntry | undefined): ExecGroup | undefined {
		if (!entry?.groupId) return undefined;
		return groupsById.get(entry.groupId);
	}

	function getElapsedMs(entries: ExecEntry[]): number | undefined {
		const startedAtValues = entries.filter((entry) => entry.status === "running").map((entry) => entry.startedAtMs);
		if (startedAtValues.length === 0) return undefined;
		return Math.max(0, Date.now() - Math.min(...startedAtValues));
	}

	return {
		getState(command) {
			return (runningCountsByCommand.get(command) ?? 0) > 0 ? "running" : "done";
		},
		getRenderInfo(toolCallId, command) {
			if (!toolCallId) {
				return {
					hidden: false,
					status: (runningCountsByCommand.get(command) ?? 0) > 0 ? "running" : "done",
				};
			}

			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) {
				return {
					hidden: false,
					status: (runningCountsByCommand.get(command) ?? 0) > 0 ? "running" : "done",
					contextGuardWrapped: contextGuardWrappedToolCallIds.has(toolCallId),
				};
			}

			if (entry.hidden) {
				return {
					hidden: true,
					status: entry.status,
					elapsedMs: getElapsedMs([entry]),
					rtkWrapped: entry.rtkWrapped,
					contextGuardWrapped: entry.contextGuardWrapped,
					sessionId: entry.sessionId,
				};
			}

			const group = getGroupForEntry(entry);
			if (!group) {
				return {
					hidden: false,
					status: entry.status,
					actionGroups: entry.summary.maskAsExplored ? [entry.summary.actions] : undefined,
					elapsedMs: getElapsedMs([entry]),
					rtkWrapped: entry.rtkWrapped,
					contextGuardWrapped: entry.contextGuardWrapped,
					sessionId: entry.sessionId,
				};
			}

			const entries = group.entryIds
				.map((groupEntryId) => entriesByToolCallId.get(groupEntryId))
				.filter((groupEntry): groupEntry is ExecEntry => Boolean(groupEntry));
			return {
				hidden: false,
				status: entries.some((groupEntry) => groupEntry.status === "running") ? "running" : "done",
				actionGroups: entries.map((groupEntry) => groupEntry.summary.actions),
				elapsedMs: getElapsedMs(entries),
				rtkWrapped: entries.some((groupEntry) => groupEntry.rtkWrapped),
				contextGuardWrapped: entries.some((groupEntry) => groupEntry.contextGuardWrapped),
			};
		},
		registerRenderContext(toolCallId, invalidate) {
			if (!toolCallId) return;
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) return;
			entry.invalidate = invalidate;
		},
		ensurePlannedExploration(toolCallId, command) {
			if (!toolCallId || entriesByToolCallId.has(toolCallId)) return;
			const summary = summarizeShellCommand(command);
			if (!summary.maskAsExplored) return;

			const entry: ExecEntry = {
				toolCallId,
				command,
				summary,
				status: "running",
				hidden: false,
				startedAtMs: Date.now(),
				rtkWrapped: false,
				contextGuardWrapped: contextGuardWrappedToolCallIds.has(toolCallId),
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

			group.entryIds.push(toolCallId);
			entry.hidden = true;
			entry.groupId = group.id;
			invalidateToolCall(group.visibleEntryId);
		},
		recordStart(toolCallId, command) {
			const existing = entriesByToolCallId.get(toolCallId);
			if (existing) {
				commandByToolCallId.set(toolCallId, command);
				incrementCommand(command);
				existing.command = command;
				existing.summary = summarizeShellCommand(command);
				existing.status = "running";
				existing.startedAtMs = Date.now();
				const group = getGroupForEntry(existing);
				invalidateToolCall(group?.visibleEntryId ?? toolCallId);
				return;
			}

			commandByToolCallId.set(toolCallId, command);
			incrementCommand(command);

			const summary = summarizeShellCommand(command);
			const entry: ExecEntry = {
				toolCallId,
				command,
				summary,
				status: "running",
				hidden: false,
				startedAtMs: Date.now(),
				rtkWrapped: false,
				contextGuardWrapped: contextGuardWrappedToolCallIds.has(toolCallId),
			};
			entriesByToolCallId.set(toolCallId, entry);

			if (!summary.maskAsExplored) {
				activeExplorationGroupId = undefined;
				return;
			}

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

			group.entryIds.push(toolCallId);
			entry.hidden = true;
			entry.groupId = group.id;
			invalidateToolCall(group.visibleEntryId);
		},
		recordRtkWrapped(toolCallId) {
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry || entry.rtkWrapped) return;
			entry.rtkWrapped = true;
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? entry.toolCallId);
		},
		recordContextGuardWrapped(toolCallId) {
			contextGuardWrappedToolCallIds.add(toolCallId);
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry || entry.contextGuardWrapped) return;
			entry.contextGuardWrapped = true;
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? entry.toolCallId);
		},
		recordPersistentSession(toolCallId, sessionId) {
			sessionBackedToolCallIds.add(toolCallId);
			toolCallIdBySessionId.set(sessionId, toolCallId);
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) return;
			entry.status = "running";
			entry.sessionId = sessionId;
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? entry.toolCallId);
		},
		recordEnd(toolCallId) {
			const command = commandByToolCallId.get(toolCallId);
			if (!command) return;
			const entry = entriesByToolCallId.get(toolCallId);
			if (!sessionBackedToolCallIds.has(toolCallId)) {
				decrementCommand(command);
				if (entry) {
					entry.status = "done";
				}
			}
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? toolCallId);
			commandByToolCallId.delete(toolCallId);
		},
		recordSessionFinished(sessionId) {
			const toolCallId = toolCallIdBySessionId.get(sessionId);
			if (!toolCallId) return;
			toolCallIdBySessionId.delete(sessionId);
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) return;
			decrementCommand(entry.command);
			entry.status = "done";
			sessionBackedToolCallIds.delete(toolCallId);
			const group = getGroupForEntry(entry);
			invalidateToolCall(group?.visibleEntryId ?? entry.toolCallId);
		},
		resetExplorationGroup() {
			activeExplorationGroupId = undefined;
		},
		clear() {
			commandByToolCallId.clear();
			runningCountsByCommand.clear();
			sessionBackedToolCallIds.clear();
			contextGuardWrappedToolCallIds.clear();
			toolCallIdBySessionId.clear();
			entriesByToolCallId.clear();
			groupsById.clear();
			activeExplorationGroupId = undefined;
			nextGroupId = 1;
		},
	};
}
