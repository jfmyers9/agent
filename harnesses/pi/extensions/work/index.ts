import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Execute, execute, type GitWork, githubRepo, repository } from "./git.js";
import { getIssue, pages, statuses } from "./linear.js";
import { connectLinear, piWorker } from "./pi-runtime.js";
import { WorkRunner } from "./runner.js";
import { WorkStore } from "./store.js";
import type { LinearPort, WorkSettings } from "./types.js";

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function settingsSummary(settings: WorkSettings): string {
	return `Project: ${settings.projectName}\nRepository: ${settings.repo}\nRemote: ${settings.remote}\nBase: ${settings.base}\nTake: assigned to you · ${settings.stateTypes.join(" / ")} · ${settings.label || "no label gate"} · unblocked\nWorker: pi · one ticket at a time · ${settings.minutes} minute limit\nVerify: ${settings.verify}\nPublish: ${settings.publish}`;
}

export function validSettings(value: WorkSettings | undefined): value is WorkSettings {
	return (
		!!value &&
		value.version === 1 &&
		["repo", "commonDir", "remote", "base", "projectId", "projectName", "userId", "verify"].every(
			(field) => typeof value[field as keyof WorkSettings] === "string" && !!value[field as keyof WorkSettings],
		) &&
		["draft-pr", "direct-push"].includes(value.publish) &&
		typeof value.label === "string" &&
		Array.isArray(value.stateTypes) &&
		value.stateTypes.length > 0 &&
		value.stateTypes.every((type) => ["backlog", "unstarted", "triage"].includes(type)) &&
		Number.isFinite(value.minutes) &&
		value.minutes >= 1 &&
		value.minutes <= 180
	);
}

export async function configure(
	ctx: ExtensionCommandContext,
	linear: LinearPort,
	store: WorkStore,
	run: Execute = execute,
): Promise<WorkSettings | undefined> {
	const repo = await repository(ctx.cwd, run);
	const previous = await store.settings(repo.commonDir);
	const user = await linear.call<{ id: string }>("get_user", { query: "me" });
	if (!user.id) throw new Error("Linear did not return your user ID.");
	const projects = await pages<{ id: string; uuid?: string; name: string }>(linear, "list_projects", "projects", {
		limit: 50,
		includeArchived: false,
		fields: ["id", "uuid", "name"],
	});
	if (!projects.length) throw new Error("No Linear projects are available. Create a project before configuring /work.");
	const labels = projects.map((project) => clean(`${project.name} (${project.id})`));
	const selected = await ctx.ui.select("Which Linear project should this repository work from?", labels);
	if (selected === undefined) return;
	const project = projects[labels.indexOf(selected)];
	if (!project) return;
	const gate = await ctx.ui.input(
		"Required ready label (leave empty to accept all intake tickets)",
		previous?.label ?? "agent-ready",
	);
	if (gate === undefined) return;
	const intake = await ctx.ui.select("Eligible intake statuses", [
		"Backlog + unstarted (recommended)",
		"Backlog + unstarted + triage",
	]);
	if (intake === undefined) return;
	const baseInput = await ctx.ui.input(
		"Base branch on origin (Enter keeps the displayed default)",
		previous?.base ?? repo.base,
	);
	if (baseInput === undefined) return;
	const base = baseInput.trim() || previous?.base || repo.base;
	await run(repo.repo, "git", ["check-ref-format", "--branch", base]);
	let suggestedCheck = "";
	try {
		const pkg = JSON.parse(await readFile(join(repo.repo, "package.json"), "utf8"));
		const manager = typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun@") ? "bun" : "npm";
		if (pkg.scripts?.check) suggestedCheck = `${manager} run check`;
		else if (pkg.scripts?.test) suggestedCheck = `${manager} run test`;
	} catch {
		/* Ask rather than inferring verification from untrusted ticket text. */
	}
	const verifyInput = await ctx.ui.input(
		"Verification command (Enter keeps the default; runs in each worktree)",
		previous?.verify ?? suggestedCheck,
	);
	if (verifyInput === undefined) return;
	const verify = verifyInput.trim() || previous?.verify || suggestedCheck;
	if (!verify.trim()) throw new Error("A verification command is required before enabling publication.");
	const publication = await ctx.ui.select("How should verified changes be published?", [
		"Draft PR (recommended)",
		"Direct push to the base branch",
	]);
	if (publication === undefined) return;
	const publish = publication.startsWith("Draft") ? "draft-pr" : "direct-push";
	const minutesText = await ctx.ui.input("Maximum minutes per ticket (1–180)", String(previous?.minutes ?? 45));
	if (minutesText === undefined) return;
	const settings: WorkSettings = {
		version: 1,
		...repo,
		base,
		projectId: project.uuid ?? project.id,
		projectName: project.name,
		userId: user.id,
		label: gate.trim(),
		stateTypes: intake.includes("+ triage") ? ["backlog", "unstarted", "triage"] : ["backlog", "unstarted"],
		publish,
		verify: verify.trim(),
		minutes: Number(minutesText.trim() || previous?.minutes || 45),
	};
	if (!validSettings(settings)) throw new Error("Invalid work settings; timeout must be between 1 and 180 minutes.");
	if (publish === "draft-pr") {
		await run(repo.repo, "gh", ["repo", "view", githubRepo(settings.remote), "--json", "nameWithOwner"]);
	}
	if (
		!(await ctx.ui.confirm(
			"Save and authorize this work policy?",
			`${settingsSummary(settings)}\n\nStarting /work authorizes claims, worktrees, verification, commits, publication, and Linear updates under this policy. Workers run trusted repository code with your local permissions; this is not a sandbox. Settings changes cannot come from tickets.`,
		))
	)
		return;
	await store.saveSettings(settings);
	return settings;
}

export interface WorkDependencies {
	store?: WorkStore;
	connect?: typeof connectLinear;
	worker?: typeof piWorker;
	repository?: typeof repository;
	configure?: typeof configure;
	git?: GitWork;
}

export default function workExtension(pi: ExtensionAPI, dependencies: WorkDependencies = {}) {
	const store = dependencies.store ?? new WorkStore();
	const connect = dependencies.connect ?? connectLinear;
	const worker = dependencies.worker ?? piWorker;
	const locate = dependencies.repository ?? repository;
	const setup = dependencies.configure ?? configure;
	let active: { runner: WorkRunner; done: Promise<void> } | undefined;
	let preparing = false;
	let closing = false;
	const stop = async () => {
		active?.runner.stop();
		await active?.done;
	};
	pi.on("session_start", () => {
		closing = false;
	});
	pi.on("session_shutdown", async () => {
		closing = true;
		await stop();
	});
	pi.on("session_tree", () => {
		active?.runner.stop();
	});
	pi.on("session_before_fork", (_event, ctx) => {
		if (active || preparing) {
			ctx.ui.notify("Pause or stop /work before forking the coordinator session.", "warning");
			return { cancel: true };
		}
	});
	pi.registerCommand("work", {
		description:
			"Work assigned, ready, unblocked Linear tickets in isolated worktrees; interactive settings, no dotfiles",
		getArgumentCompletions: (prefix) =>
			["loop", "settings", "status", "pause", "stop", "recover", "retry ", "sync "]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim();
			try {
				if (!ctx.hasUI) throw new Error("/work requires an interactive pi coordinator session.");
				if (action === "status") {
					const owner = await store.owner();
					const jobs = (await store.jobs()).slice(0, 8);
					ctx.ui.notify(
						`${active ? clean(active.runner.status.message) : owner ? `Runner owned by session ${owner.session} (PID ${owner.pid})` : "No active local runner."}\n${jobs.map((job) => `${job.issueId} · ${job.phase} · ${clean(job.error ?? job.publication ?? job.worktree)}`).join("\n")}`,
						"info",
					);
					return;
				}
				if (action === "pause" || action === "stop") {
					if (!active) throw new Error("No runner in this session. Use /work status to find its owner.");
					if (action === "pause") active.runner.pause();
					else active.runner.stop();
					ctx.ui.notify(
						action === "pause"
							? "Finishing this ticket, then pausing."
							: "Stopping; unfinished work will be preserved.",
						"info",
					);
					return;
				}
				if (!["", "loop", "settings", "recover"].includes(action) && !/^(retry|sync)\s+\S+$/.test(action))
					throw new Error("Usage: /work [loop|settings|status|pause|stop|recover|retry ISSUE|sync ISSUE]");
				if (active || preparing)
					throw new Error("This session already has a work operation. Use /work status, pause, or stop.");
				preparing = true;
				let linear: Awaited<ReturnType<typeof connectLinear>> | undefined;
				let handedOff = false;
				try {
					if (action === "recover") {
						if (
							await ctx.ui.confirm(
								"Recover a crashed local runner?",
								"Only a lock whose owning process is dead will be removed. Unfinished work is preserved and is NOT automatically restarted; publishing attempts require remote inspection.",
							)
						)
							await store.recover();
						return;
					}
					if (await store.owner())
						throw new Error(
							"Another local runner owns the queue. Use /work status; stop its owning session or recover after a crash.",
						);
					const repo = await locate(ctx.cwd);
					linear = await connect(repo.repo, ctx.model);
					if (/^(retry|sync)\s/.test(action)) {
						const [operation, id] = action.split(/\s+/);
						const job = await store.job(id!);
						if (job && (await linear.call<{ id: string }>("get_user", { query: "me" })).id !== job.settings.userId)
							throw new Error("Linear sign-in changed. Reconcile this attempt under its original account.");
						if (!job || job.settings.commonDir !== repo.commonDir)
							throw new Error(
								"No matching attempt in this repository. Use its exact issue identifier from /work status.",
							);
						const release = await store.lock(ctx.sessionManager.getSessionId());
						try {
							if (operation === "sync") {
								if (
									await ctx.ui.confirm(
										"Sync confirmed publication to Linear?",
										`${id}: ${job.publication ?? "No confirmed publication"}`,
									)
								)
									await new WorkRunner(store, linear, piWorker({ stateDir: store.root })).sync(job);
							} else if (
								await ctx.ui.confirm(
									"Retry from a fresh base?",
									`Inspect preserved work first: ${job.worktree}\nThis restores the ticket to intake and archives the prior attempt. It does not delete or overwrite that worktree.`,
								)
							) {
								if (
									job.commit ||
									job.publication ||
									["publishing", "published", "published-needs-sync"].includes(job.phase)
								)
									throw new Error("Inspect possible publication manually; automatic retry is unsafe.");
								const issue = await getIssue(linear, job.issueId);
								if (
									issue.assigneeId !== job.settings.userId ||
									issue.projectId !== job.settings.projectId ||
									![...job.settings.stateTypes, "started"].includes(issue.statusType)
								)
									throw new Error("Issue ownership, project, or status changed; reconcile manually.");
								const intake = (await statuses(linear, issue.teamId)).find((status) =>
									job.settings.stateTypes.includes(status.type),
								);
								if (!intake) throw new Error("No configured intake state is available.");
								await linear.call("save_issue", { id: job.issueId, state: intake.id });
								await store.archiveJob(job.issueId);
								ctx.ui.notify(`${job.issueId} returned to intake. Run /work to pick up eligible work.`, "info");
							}
						} finally {
							await release();
						}
						return;
					}
					let settings = await store.settings(repo.commonDir);
					if (action === "settings" || !validSettings(settings)) settings = await setup(ctx, linear, store);
					if (!settings || action === "settings" || closing) return;
					if (settings.commonDir !== repo.commonDir || settings.remote !== repo.remote)
						throw new Error("Repository identity changed. Run /work settings before starting.");
					const currentUser = await linear.call<{ id: string }>("get_user", { query: "me" });
					if (currentUser.id !== settings.userId)
						throw new Error("Linear sign-in changed. Run /work settings to select the new account's queue.");
					ctx.ui.notify(settingsSummary(settings), "info");
					const runner = new WorkRunner(
						store,
						linear,
						worker({ model: ctx.model, thinkingLevel: pi.getThinkingLevel(), stateDir: store.root }),
						dependencies.git,
						(status) => {
							ctx.ui.setStatus(
								"work",
								clean(`Work · ${status.issueId ?? status.phase} · ${status.message}`).slice(0, 160),
							);
							if (
								["done", "awaiting-review", "needs-input", "interrupted", "published-needs-sync"].includes(status.phase)
							)
								ctx.ui.notify(
									clean(`${status.issueId} · ${status.phase}: ${status.message}`).slice(0, 2000),
									["done", "awaiting-review"].includes(status.phase) ? "info" : "warning",
								);
						},
					);
					const connection = linear;
					// Start in a microtask so even synchronous failures see the active handle.
					const done = Promise.resolve()
						.then(() => runner.run(settings!, action === "loop", ctx.sessionManager.getSessionId()))
						.catch((error) => {
							if (!closing) ctx.ui.notify(`Work stopped: ${clean(String(error))}`, "error");
						})
						.finally(async () => {
							try {
								await connection.close();
							} catch (error) {
								if (!closing) ctx.ui.notify(`Work connection cleanup failed: ${clean(String(error))}`, "error");
							}
							active = undefined;
							ctx.ui.setStatus("work", undefined);
							if (!closing)
								ctx.ui.notify(
									`Work runner stopped. ${clean(runner.status.message)} Use /work status for preserved attempts.`,
									"info",
								);
						});
					active = { runner, done };
					handedOff = true;
				} finally {
					preparing = false;
					if (linear && !handedOff) await linear.close();
				}
			} catch (error) {
				ctx.ui.notify(clean(error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});
}
