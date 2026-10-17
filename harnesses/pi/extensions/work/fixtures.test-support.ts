import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue, LinearPort, Status, WorkJob, WorkSettings } from "./types";

export const temporaryRoot = () => mkdtemp(join(tmpdir(), "agent-work-test-"));
export const settings = (root: string): WorkSettings => ({
	version: 1,
	repo: root,
	commonDir: join(root, ".git"),
	remote: "git@github.com:example/project.git",
	base: "main",
	projectId: "project",
	projectName: "Example",
	userId: "user",
	label: "agent-ready",
	stateTypes: ["backlog", "unstarted"],
	publish: "draft-pr",
	verify: "test -f app.txt",
	minutes: 1,
});
export const issue = (id = "DEV-1", changes: Partial<Issue> = {}): Issue => ({
	id,
	title: "Implement an example change",
	description: "Update app.txt",
	url: `https://example.com/${id}`,
	assigneeId: "user",
	projectId: "project",
	teamId: "team",
	status: "Backlog",
	statusType: "backlog",
	labels: ["agent-ready"],
	priority: 0,
	relations: { blockedBy: [] },
	...changes,
});
export const job = (root: string, changes: Partial<WorkJob> = {}): WorkJob => ({
	version: 1,
	runId: "test-run",
	issueId: "DEV-1",
	title: "Example",
	issueUrl: "https://example.com/DEV-1",
	settings: settings(root),
	phase: "implementing",
	updatedAt: new Date().toISOString(),
	worktree: join(root, "worktree"),
	branch: "work/dev-1-test",
	...changes,
});

export class FakeLinear implements LinearPort {
	projects: Array<{ id: string; uuid?: string; name: string }> = [{ id: "project", name: "Example" }];
	readonly calls: Array<{ name: string; args: Record<string, any> }> = [];
	readonly workflow: Status[] = [
		{ id: "backlog", name: "Backlog", type: "backlog" },
		{ id: "started", name: "In Progress", type: "started" },
		{ id: "review", name: "In Review", type: "started" },
		{ id: "done", name: "Done", type: "completed" },
	];
	before?: (name: string, args: Record<string, any>) => void | Promise<void>;
	constructor(readonly issues: Issue[] = [issue()]) {}
	async call<T>(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<T> {
		signal?.throwIfAborted();
		this.calls.push({ name, args });
		await this.before?.(name, args);
		let result: unknown;
		if (name === "list_issues") result = { issues: this.issues, hasNextPage: false };
		else if (name === "get_issue") {
			result = this.issues.find((item) => item.id === args.id);
			if (!result) throw new Error("Missing issue");
		} else if (name === "list_issue_statuses") result = this.workflow;
		else if (name === "get_user") result = { id: "user" };
		else if (name === "list_projects") result = { projects: this.projects, hasNextPage: false };
		else if (name === "save_issue") {
			const target = this.issues.find((item) => item.id === args.id)!;
			if (args.state) {
				const state = this.workflow.find((item) => item.id === args.state)!;
				target.status = state.name;
				target.statusType = state.type;
			}
			result = target;
		} else if (name === "save_comment") result = { id: "comment" };
		else throw new Error(`Unexpected Linear call: ${name}`);
		return structuredClone(result) as T;
	}
}
