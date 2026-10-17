import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GitWork } from "./git.js";
import { eligible, getIssue, pages, statuses, unblocked } from "./linear.js";
import type { WorkStore } from "./store.js";
import type { Issue, LinearPort, RunStatus, WorkerPort, WorkJob, WorkSettings } from "./types.js";

export class WorkRunner {
	private readonly abort = new AbortController();
	private pausing = false;
	private wake?: () => void;
	status: RunStatus = { phase: "starting", message: "Starting" };
	constructor(
		readonly store: WorkStore,
		readonly linear: LinearPort,
		readonly worker: WorkerPort,
		readonly git = new GitWork(),
		private readonly update: (status: RunStatus) => void = () => {},
		private readonly pollMs = 60_000,
	) {}
	pause() {
		this.pausing = true;
		this.wake?.();
		this.set("pausing", "Finish current ticket, then pause");
	}
	stop() {
		this.pausing = true;
		this.abort.abort();
		this.set("stopping", "Stopping; unfinished work will be preserved");
	}
	private set(phase: string, message: string, issueId?: string) {
		this.status = { phase, message, issueId };
		this.update(this.status);
	}
	private async save(job: WorkJob, phase: WorkJob["phase"], message: string) {
		job.phase = phase;
		await this.store.saveJob(job);
		this.set(phase, message, job.issueId);
	}
	async candidate(settings: WorkSettings, signal = this.abort.signal): Promise<Issue | undefined> {
		const issues = await pages<Issue>(
			this.linear,
			"list_issues",
			"issues",
			{
				project: settings.projectId,
				assignee: settings.userId,
				includeArchived: false,
				limit: 100,
				...(settings.label ? { label: settings.label } : {}),
				fields: [
					"id",
					"title",
					"assigneeId",
					"projectId",
					"teamId",
					"status",
					"statusType",
					"labels",
					"priority",
					"archivedAt",
				],
			},
			signal,
		);
		const priority = (issue: Issue) =>
			(typeof issue.priority === "number" ? issue.priority : issue.priority?.value) || 5;
		issues.sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id));
		for (const summary of issues) {
			signal.throwIfAborted();
			if (!eligible(summary, settings) || (await this.store.job(summary.id))) continue;
			const issue = await getIssue(this.linear, summary.id, signal);
			if (eligible(issue, settings) && (await unblocked(this.linear, issue, signal))) return issue;
		}
		return undefined;
	}
	async sync(job: WorkJob, signal?: AbortSignal): Promise<void> {
		if (!job.publication || !job.commit)
			throw new Error("No confirmed publication is recorded. Inspect the remote manually before retrying.");
		const issue = await getIssue(this.linear, job.issueId, signal);
		if (issue.assigneeId !== job.settings.userId || issue.projectId !== job.settings.projectId)
			throw new Error("Issue ownership or project changed; reconcile manually.");
		if (!["started", "completed"].includes(issue.statusType))
			throw new Error("Issue workflow changed before sync; reconcile manually rather than overwriting it.");
		const workflow = await statuses(this.linear, issue.teamId, signal);
		const state =
			job.settings.publish === "direct-push"
				? workflow.find((status) => status.type === "completed")
				: workflow.find((status) => status.type === "started" && /review/i.test(status.name));
		if (job.settings.publish === "direct-push" && !state)
			throw new Error("Completed workflow status is unavailable; publication needs manual sync.");
		await this.linear.call(
			"save_issue",
			{
				id: job.issueId,
				...(state && issue.statusType !== "completed" ? { state: state.id } : {}),
				...(job.settings.publish === "draft-pr"
					? { links: [{ url: job.publication, title: "Draft implementation PR" }] }
					: {}),
			},
			signal,
		);
		const comment = await this.linear.call<{ id: string }>(
			"save_comment",
			{
				...(job.commentId ? { id: job.commentId } : { issueId: job.issueId }),
				body: `${job.settings.publish === "draft-pr" && issue.statusType !== "completed" ? "Awaiting human review (not complete)." : "Implementation published."}\n\n${job.summary}\n\nPublication: ${job.publication}\nCommit: ${job.commit}\nVerification passed: \`${job.settings.verify}\``,
			},
			signal,
		);
		job.commentId = comment.id;
		await this.save(
			job,
			job.settings.publish === "draft-pr" && issue.statusType !== "completed" ? "awaiting-review" : "done",
			job.publication,
		);
	}
	private async attempt(settings: WorkSettings, selected: Issue): Promise<void> {
		const runId = randomUUID();
		const job: WorkJob = {
			version: 1,
			runId,
			issueId: selected.id,
			title: selected.title,
			issueUrl: selected.url,
			settings,
			phase: "claiming",
			updatedAt: new Date().toISOString(),
			branch: `work/${selected.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${runId.slice(0, 8)}`,
			worktree: join(this.store.root, "worktrees", runId),
			summary: selected.description ?? "",
		};
		const timer = new AbortController();
		const timeout = setTimeout(() => timer.abort(), settings.minutes * 60_000);
		timeout.unref();
		const signal = AbortSignal.any([this.abort.signal, timer.signal]);
		let claimedByUs = false;
		try {
			await this.save(job, "claiming", "Rechecking eligibility and claiming");
			const issue = await getIssue(this.linear, job.issueId, signal);
			if (!eligible(issue, settings) || !(await unblocked(this.linear, issue, signal)))
				throw new Error("Issue is no longer ready or unblocked.");
			const workflow = await statuses(this.linear, issue.teamId, signal);
			const started =
				workflow.find(
					(status) => status.type === "started" && /progress|implement|doing|coding|development/i.test(status.name),
				) ?? workflow.find((status) => status.type === "started" && !/review|blocked/i.test(status.name));
			if (!started || !workflow.some((status) => status.type === "completed"))
				throw new Error("Team needs started and completed workflow statuses.");
			await this.linear.call("save_issue", { id: issue.id, state: started.id }, signal);
			const claimed = await getIssue(this.linear, issue.id, signal);
			if (
				claimed.statusType !== "started" ||
				claimed.assigneeId !== settings.userId ||
				claimed.projectId !== settings.projectId
			)
				throw new Error("Claim could not be confirmed.");
			claimedByUs = true;
			if (
				(settings.label &&
					!claimed.labels.some((label) => (typeof label === "string" ? label : label.name) === settings.label)) ||
				!(await unblocked(this.linear, claimed, signal))
			)
				throw new Error("Readiness or blockers changed while claiming; work has not started.");
			job.title = claimed.title;
			job.issueUrl = claimed.url;
			const requirements = claimed.description ?? "";
			job.summary = requirements;
			await this.git.prepare(job, signal);
			await this.save(job, "implementing", "Implementing in a fresh pi session");
			const report = await this.worker.run(job, signal, (message) => this.set("implementing", message, job.issueId));
			job.summary = report.summary;
			if (report.outcome !== "ready") throw new Error(report.summary);
			await this.save(job, "verifying", "Running configured verification");
			await this.git.verify(job, signal, join(this.store.root, `verify-${runId}.log`));
			const current = await getIssue(this.linear, issue.id, signal);
			if (
				current.statusType !== "started" ||
				current.assigneeId !== settings.userId ||
				current.projectId !== settings.projectId ||
				current.title !== job.title ||
				(current.description ?? "") !== requirements ||
				(settings.label &&
					!current.labels.some((label) => (typeof label === "string" ? label : label.name) === settings.label)) ||
				!(await unblocked(this.linear, current, signal))
			)
				throw new Error("Issue changed or gained a blocker during implementation; publication stopped.");
			await this.git.commit(job, report, signal);
			await this.save(job, "publishing", "Publishing verified commit");
			job.publication = await this.git.publish(job, signal);
			await this.save(job, "published", job.publication);
			await this.sync(job, signal);
		} catch (error) {
			const failedDuringClaim = job.phase === "claiming";
			job.error = error instanceof Error ? error.message : String(error);
			if (timer.signal.aborted) job.error = `Ticket exceeded its ${settings.minutes}-minute limit. ${job.error}`;
			const phase = job.publication ? "published-needs-sync" : signal.aborted ? "interrupted" : "needs-input";
			await this.save(job, phase, `${job.error} · Work preserved at ${job.worktree}`);
			if (claimedByUs && !job.commit) {
				try {
					const comment = await this.linear.call<{ id: string }>(
						"save_comment",
						{
							issueId: job.issueId,
							body: `Work attempt ${phase}. The coordinator did not attempt publication.\n\n${job.error.slice(0, 1500)}\n\nWork is preserved on the runner; inspect /work status before retrying.`,
						},
						AbortSignal.timeout(15_000),
					);
					job.commentId = comment.id;
					await this.store.saveJob(job);
				} catch {
					/* Local recovery remains authoritative when Linear is unavailable. */
				}
			}
			// Publishing failures are ambiguous: never advance automatically after
			// a push/PR request whose remote result may have been lost.
			if (failedDuringClaim || job.commit || job.publication) this.pausing = true;
		} finally {
			clearTimeout(timeout);
		}
	}
	async run(settings: WorkSettings, loop: boolean, session: string): Promise<void> {
		const release = await this.store.lock(session);
		try {
			await this.git.preflight(settings, this.abort.signal);
			do {
				if (this.pausing || this.abort.signal.aborted) break;
				this.set("selecting", "Looking for assigned, ready, unblocked issues");
				const issue = await this.candidate(settings);
				if (this.pausing || this.abort.signal.aborted) break;
				if (issue) await this.attempt(settings, issue);
				else {
					this.set("waiting", loop ? "No eligible tickets; checking again in 60 seconds" : "No eligible tickets.");
					if (loop && !this.pausing)
						await new Promise<void>((resolve) => {
							const finish = () => {
								clearTimeout(timer);
								this.abort.signal.removeEventListener("abort", finish);
								this.wake = undefined;
								resolve();
							};
							const timer = setTimeout(finish, this.pollMs);
							this.wake = finish;
							timer.unref();
							this.abort.signal.addEventListener("abort", finish, { once: true });
							if (this.abort.signal.aborted) finish();
						});
				}
			} while (loop && !this.pausing && !this.abort.signal.aborted);
		} finally {
			await release();
		}
	}
}
