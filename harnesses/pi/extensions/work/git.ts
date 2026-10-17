import { spawn } from "node:child_process";
import { appendFile, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { WorkJob, WorkReport, WorkSettings } from "./types.js";

export interface CommandResult {
	stdout: string;
	stderr: string;
	truncated?: boolean;
}
export interface CommandOptions {
	signal?: AbortSignal;
	timeout?: number;
	log?: string;
}
export type Execute = (
	cwd: string,
	command: string,
	args: string[],
	options?: CommandOptions,
) => Promise<CommandResult>;

export const execute: Execute = async (cwd, command, args, options = {}) => {
	options.signal?.throwIfAborted();
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, args, {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
		});
		let stdout = "";
		let stderr = "";
		let cancelled = false;
		let truncated = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") stderr += String(error);
			}
		};
		const cancel = () => {
			if (cancelled) return;
			cancelled = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), 2000);
			killTimer.unref();
		};
		const timer = setTimeout(cancel, options.timeout ?? 90_000);
		timer.unref();
		options.signal?.addEventListener("abort", cancel, { once: true });
		child.stdout.on("data", (data) => {
			if (stdout.length + data.length > 256_000) truncated = true;
			stdout = (stdout + data.toString()).slice(-256_000);
		});
		child.stderr.on("data", (data) => {
			stderr = (stderr + data.toString()).slice(-256_000);
		});
		const cleanup = () => {
			clearTimeout(timer);
			if (!cancelled && killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", cancel);
		};
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", async (code) => {
			cleanup();
			try {
				if (options.log)
					await appendFile(options.log, `\n$ ${command} ${JSON.stringify(args)}\n${stdout}${stderr}\n`, {
						mode: 0o600,
					});
				if (cancelled) throw new Error(options.signal?.aborted ? "Work stopped." : `Command timed out: ${command}`);
				if (code !== 0) throw new Error(`${command} exited ${code}: ${(stderr || stdout).trim().slice(-4000)}`);
				resolveResult({ stdout, stderr, truncated });
			} catch (error) {
				reject(error);
			}
		});
		if (options.signal?.aborted) cancel();
	});
};

export async function repository(cwd: string, run: Execute = execute) {
	const repo = await realpath((await run(cwd, "git", ["rev-parse", "--show-toplevel"])).stdout.trim());
	const common = (await run(repo, "git", ["rev-parse", "--git-common-dir"])).stdout.trim();
	const commonDir = await realpath(resolve(repo, common));
	const remote = (await run(repo, "git", ["remote", "get-url", "origin"])).stdout.trim();
	if (/^https?:\/\/[^/]*@/i.test(remote))
		throw new Error("Use a Git credential helper rather than credentials embedded in the origin URL.");
	let base = "main";
	try {
		base = (await run(repo, "git", ["symbolic-ref", "refs/remotes/origin/HEAD"])).stdout
			.trim()
			.replace(/^refs\/remotes\/origin\//, "");
	} catch {
		/* The setup dialog confirms the fallback rather than guessing silently. */
	}
	return { repo, commonDir, remote, base };
}

export function githubRepo(remote: string): string {
	const normalized = remote.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://");
	let url: URL;
	try {
		url = new URL(normalized);
	} catch {
		throw new Error("Draft PR mode requires a GitHub remote URL.");
	}
	const path = url.pathname
		.replace(/^\//, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
	if (
		!["https:", "http:"].includes(url.protocol) ||
		!url.host ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!/^[\w.-]+\/[\w.-]+$/.test(path)
	)
		throw new Error("Unsupported GitHub remote URL.");
	return `${url.host}/${path}`;
}

export class GitWork {
	constructor(readonly run: Execute = execute) {}
	async preflight(settings: WorkSettings, signal?: AbortSignal): Promise<void> {
		await this.checkRemote(settings, signal);
		await this.run(settings.repo, "git", ["var", "GIT_AUTHOR_IDENT"], { signal });
		await this.run(settings.repo, "git", ["var", "GIT_COMMITTER_IDENT"], { signal });
		if (settings.publish === "draft-pr")
			await this.run(settings.repo, "gh", ["repo", "view", githubRepo(settings.remote), "--json", "nameWithOwner"], {
				signal,
			});
	}
	async checkRemote(settings: WorkSettings, signal?: AbortSignal): Promise<void> {
		const fetch = (await this.run(settings.repo, "git", ["remote", "get-url", "origin"], { signal })).stdout.trim();
		const push = (
			await this.run(settings.repo, "git", ["remote", "get-url", "--push", "--all", "origin"], { signal })
		).stdout.trim();
		if (fetch !== settings.remote || push !== settings.remote)
			throw new Error(
				"Repository remote changed or has a separate push URL. Run /work settings to authorize the new target.",
			);
	}
	async prepare(job: WorkJob, signal: AbortSignal): Promise<void> {
		const settings = job.settings;
		await this.checkRemote(settings, signal);
		await this.run(settings.repo, "git", ["check-ref-format", "--branch", settings.base], { signal });
		const ref = `refs/agent-work/${job.runId}/base`;
		await this.run(settings.repo, "git", ["fetch", "--no-tags", "origin", `refs/heads/${settings.base}:${ref}`], {
			signal,
		});
		job.baseSha = (await this.run(settings.repo, "git", ["rev-parse", ref], { signal })).stdout.trim();
		await mkdir(dirname(job.worktree), { recursive: true, mode: 0o700 });
		await this.run(settings.repo, "git", ["worktree", "add", "-b", job.branch, job.worktree, job.baseSha], { signal });
	}
	async verify(job: WorkJob, signal: AbortSignal, log: string): Promise<void> {
		if ((await this.run(job.worktree, "git", ["rev-parse", "HEAD"], { signal })).stdout.trim() !== job.baseSha) {
			throw new Error("Worker changed HEAD. Preserve and inspect its commits; refusing automatic publication.");
		}
		await this.run(job.worktree, "sh", ["-lc", job.settings.verify], {
			signal,
			timeout: job.settings.minutes * 60_000,
			log,
		});
	}
	async commit(job: WorkJob, report: WorkReport, signal: AbortSignal): Promise<void> {
		const options = { signal };
		if (
			(await this.run(job.worktree, "git", ["symbolic-ref", "--short", "HEAD"], options)).stdout.trim() !== job.branch
		)
			throw new Error("Worker changed branches; inspect the preserved worktree.");
		if ((await this.run(job.worktree, "git", ["rev-parse", "HEAD"], options)).stdout.trim() !== job.baseSha)
			throw new Error("HEAD changed during verification.");
		const listing = await this.run(
			job.worktree,
			"git",
			["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
			options,
		);
		if (listing.truncated) throw new Error("Changed-file list exceeds the inspection limit; inspect manually.");
		const alreadyStaged = await this.run(job.worktree, "git", ["diff", "--cached", "--name-only", "-z"], options);
		if (alreadyStaged.truncated) throw new Error("Staged-file list exceeds the inspection limit; inspect manually.");
		const files = `${listing.stdout}\0${alreadyStaged.stdout}`.split("\0").filter(Boolean);
		if (
			files.some((path) =>
				/(^|\/)(\.env(?:\..*)?|[^/]*\.(?:pem|key)|id_rsa|id_ed25519|credentials(?:\..*)?)$/i.test(path),
			)
		) {
			throw new Error("Potentially sensitive file changed. Human inspection is required before committing.");
		}
		const message = report.commitMessage.trim();
		if (!/^(feat|fix|docs|test|refactor|perf|build|ci|chore)(\([\w./-]+\))?!?: .+/.test(message.split("\n")[0] ?? ""))
			throw new Error("Worker did not supply a Conventional Commit message.");
		await this.run(job.worktree, "git", ["add", "-A", "--", "."], options);
		const staged = await this.run(job.worktree, "git", ["diff", "--cached", "--no-ext-diff", "--no-textconv"], options);
		if (staged.truncated) throw new Error("Staged diff exceeds the automated inspection limit; inspect manually.");
		const diff = staged.stdout;
		if (!diff.trim())
			throw new Error("No changes to publish. Human inspection is required before completing the issue.");
		if (/^\+\s*-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/m.test(diff))
			throw new Error("Possible private key in staged changes; inspect the preserved worktree.");
		await this.run(job.worktree, "git", ["diff", "--cached", "--check"], options);
		const tree = (await this.run(job.worktree, "git", ["write-tree"], options)).stdout.trim();
		await this.run(job.worktree, "git", ["commit", "-m", message], options);
		job.commit = (await this.run(job.worktree, "git", ["rev-parse", "HEAD"], options)).stdout.trim();
		if ((await this.run(job.worktree, "git", ["rev-parse", "HEAD^{tree}"], options)).stdout.trim() !== tree)
			throw new Error("Commit hooks changed the verified tree; inspect before publishing.");
		if ((await this.run(job.worktree, "git", ["status", "--porcelain"], options)).stdout.trim())
			throw new Error("Commit hooks left a dirty worktree; refusing publication.");
	}
	async publish(job: WorkJob, signal: AbortSignal): Promise<string> {
		const settings = job.settings;
		const options = { signal };
		await this.checkRemote(settings, signal);
		if ((await this.run(job.worktree, "git", ["rev-parse", "HEAD"], options)).stdout.trim() !== job.commit)
			throw new Error("HEAD changed before publication.");
		if (settings.publish === "direct-push") {
			const latest = (
				await this.run(settings.repo, "git", ["ls-remote", "origin", `refs/heads/${settings.base}`], options)
			).stdout.split(/\s/)[0];
			if (latest !== job.baseSha)
				throw new Error("Base branch advanced. Work preserved; no automatic pull, rebase, or force push.");
			await this.run(job.worktree, "git", ["push", "origin", `HEAD:refs/heads/${settings.base}`], options);
			return `commit ${job.commit} pushed to ${settings.base}`;
		}
		const repo = githubRepo(settings.remote);
		await this.run(job.worktree, "git", ["push", "origin", `HEAD:refs/heads/${job.branch}`], options);
		return (
			await this.run(
				job.worktree,
				"gh",
				[
					"pr",
					"create",
					"--repo",
					repo,
					"--draft",
					"--head",
					job.branch,
					"--base",
					settings.base,
					"--title",
					`${job.issueId}: ${job.title}`,
					"--body",
					`${job.issueUrl}\n\n${job.summary}\n\nVerification: \`${settings.verify}\`\n\nCreated by the work runner; human review is required.`,
				],
				options,
			)
		).stdout.trim();
	}
}
