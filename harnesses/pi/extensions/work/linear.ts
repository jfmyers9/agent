import type { Issue, LinearPort, Status, WorkSettings } from "./types.js";

/** MCP tools may return structured JSON or a CallToolResult containing JSON text. */
export function unwrap(value: unknown): any {
	if (typeof value === "string") return unwrap(JSON.parse(value));
	if (!value || typeof value !== "object") throw new Error("Linear returned an invalid response.");
	const object = value as Record<string, any>;
	if (object.isError) throw new Error(JSON.stringify(object.content ?? object));
	if (object.structuredContent) return unwrap(object.structuredContent);
	if (Array.isArray(object.content)) {
		const text = object.content
			.filter((item: any) => item.type === "text")
			.map((item: any) => item.text)
			.join("\n");
		return unwrap(text);
	}
	return object;
}

export async function pages<T>(
	linear: LinearPort,
	tool: string,
	field: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T[]> {
	const result: T[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 100; page++) {
		const response = await linear.call<any>(tool, { ...args, ...(cursor ? { cursor } : {}) }, signal);
		const items = Array.isArray(response) ? response : response[field];
		if (!Array.isArray(items)) throw new Error(`Linear ${tool} omitted ${field}.`);
		result.push(...items);
		if (!response.hasNextPage) return result;
		if (!response.cursor || response.cursor === cursor)
			throw new Error("Linear returned an invalid pagination cursor.");
		cursor = response.cursor;
	}
	throw new Error("Linear pagination limit reached; narrow the project scope.");
}

export function eligible(issue: Issue, settings: WorkSettings): boolean {
	return (
		!!issue &&
		!issue.archivedAt &&
		issue.assigneeId === settings.userId &&
		issue.projectId === settings.projectId &&
		settings.stateTypes.includes(issue.statusType) &&
		Array.isArray(issue.labels) &&
		(!settings.label ||
			issue.labels.some((label) => (typeof label === "string" ? label : label.name) === settings.label))
	);
}

export async function getIssue(linear: LinearPort, id: string, signal?: AbortSignal): Promise<Issue> {
	return linear.call<Issue>("get_issue", { id, includeRelations: true }, signal);
}

export async function unblocked(linear: LinearPort, issue: Issue, signal?: AbortSignal): Promise<boolean> {
	if (!Array.isArray(issue.relations?.blockedBy))
		throw new Error(`Dependency information missing for ${issue.id}; refusing to guess.`);
	for (const blocker of issue.relations.blockedBy) {
		if (!blocker.id || (await getIssue(linear, blocker.id, signal)).statusType !== "completed") return false;
	}
	return true;
}

export async function statuses(linear: LinearPort, team: string, signal?: AbortSignal): Promise<Status[]> {
	const response = await linear.call<any>("list_issue_statuses", { team }, signal);
	const list = Array.isArray(response) ? response : response.statuses;
	if (!Array.isArray(list)) throw new Error("Linear omitted team workflow statuses.");
	return list;
}
