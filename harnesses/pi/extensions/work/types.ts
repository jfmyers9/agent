export type PublishMode = "draft-pr" | "direct-push";

export interface WorkSettings {
	version: 1;
	repo: string;
	commonDir: string;
	remote: string;
	base: string;
	projectId: string;
	projectName: string;
	userId: string;
	label: string;
	stateTypes: string[];
	publish: PublishMode;
	verify: string;
	minutes: number;
}

export interface Issue {
	id: string;
	title: string;
	description?: string;
	url: string;
	assigneeId: string;
	projectId: string;
	teamId: string;
	status: string;
	statusType: string;
	labels: Array<string | { name: string }>;
	archivedAt?: string | null;
	priority?: number | { value: number };
	relations?: { blockedBy: Array<{ id: string }> };
}

export interface Status {
	id: string;
	name: string;
	type: string;
}
export interface WorkReport {
	outcome: "ready" | "needs-input";
	summary: string;
	commitMessage: string;
}

export type JobPhase =
	| "claiming"
	| "implementing"
	| "verifying"
	| "publishing"
	| "published"
	| "done"
	| "awaiting-review"
	| "needs-input"
	| "interrupted"
	| "published-needs-sync";

export interface WorkJob {
	version: 1;
	runId: string;
	issueId: string;
	title: string;
	issueUrl: string;
	settings: WorkSettings;
	phase: JobPhase;
	updatedAt: string;
	worktree: string;
	branch: string;
	baseSha?: string;
	commit?: string;
	publication?: string;
	summary?: string;
	error?: string;
	commentId?: string;
}

export interface LinearPort {
	call<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

export interface WorkerPort {
	run(job: WorkJob, signal: AbortSignal, progress: (message: string) => void): Promise<WorkReport>;
}

export interface RunStatus {
	phase: string;
	issueId?: string;
	message: string;
}
