type Coordinator = {
	snapshot(): ReadonlyArray<{ id: string; status: string }>;
};

export type CoordinatorLookup = (sessionId: string) => Coordinator | undefined;

// Resource loaders may evaluate extensions separately for child sessions.
const lookupKey = Symbol.for("agent-config.subagents.coordinator-lookup.v1");
const shared = globalThis as typeof globalThis & { [lookupKey]?: CoordinatorLookup };

export function installCoordinatorLookup(lookup: CoordinatorLookup): void {
	shared[lookupKey] = lookup;
}

export function hasActiveSubagents(sessionId: string): boolean {
	return (
		shared[lookupKey]?.(sessionId)
			?.snapshot()
			.some((agent) => agent.id !== "/root" && (agent.status === "queued" || agent.status === "running")) ?? false
	);
}
