import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, GitWork, githubRepo, repository } from "./git";
import { FakeLinear, job, settings, temporaryRoot } from "./fixtures.test-support";
import { WorkRunner } from "./runner";
import { WorkStore } from "./store";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await temporaryRoot();
	roots.push(root);
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	await mkdir(repo);
	await execute(root, "git", ["init", "--bare", "--initial-branch=main", remote]);
	await execute(repo, "git", ["init", "--initial-branch=main"]);
	await execute(repo, "git", ["config", "user.name", "Test"]);
	await execute(repo, "git", ["config", "user.email", "test@example.com"]);
	await writeFile(join(repo, "app.txt"), "before\n");
	await execute(repo, "git", ["add", "."]);
	await execute(repo, "git", ["commit", "-m", "chore: initialize fixture"]);
	await execute(repo, "git", ["remote", "add", "origin", remote]);
	await execute(repo, "git", ["push", "-u", "origin", "main"]);
	const config = { ...settings(repo), remote, commonDir: join(repo, ".git"), publish: "direct-push" as const };
	const store = new WorkStore(join(root, "state"));
	return { root, repo, remote, config, store };
}

test("real Git cycle isolates dirty/staged user work, verifies, commits, and directly pushes", async () => {
	const f = await fixture();
	await writeFile(join(f.repo, "app.txt"), "user edit\n");
	await writeFile(join(f.repo, "user.txt"), "staged user work\n");
	await execute(f.repo, "git", ["add", "user.txt"]);
	const before = (await execute(f.repo, "git", ["status", "--porcelain"])).stdout;
	const linear = new FakeLinear();
	const runner = new WorkRunner(f.store, linear, {
		async run(attempt) {
			expect(await readFile(join(attempt.worktree, "app.txt"), "utf8")).toBe("before\n");
			await writeFile(join(attempt.worktree, "app.txt"), "implemented\n");
			return {
				outcome: "ready",
				summary: "Implemented fixture behavior",
				commitMessage: "feat: implement fixture behavior\n\nProvide the requested behavior in the isolated worktree.",
			};
		},
	});
	await runner.run(f.config, false, "session");
	expect((await f.store.job("DEV-1"))?.phase).toBe("done");
	expect((await execute(f.repo, "git", ["status", "--porcelain"])).stdout).toBe(before);
	expect(await readFile(join(f.repo, "app.txt"), "utf8")).toBe("user edit\n");
	expect((await execute(f.remote, "git", ["show", "main:app.txt"])).stdout).toBe("implemented\n");
	expect(linear.issues[0]!.statusType).toBe("completed");
	const identity = await repository((await f.store.job("DEV-1"))!.worktree);
	expect(identity.commonDir).toBe(await realpath(f.config.commonDir));
}, 20_000);

test("direct publication refuses an advanced base without force-pushing", async () => {
	const f = await fixture();
	const git = new GitWork();
	const attempt = job(f.root, { settings: f.config, worktree: join(f.root, "worker") });
	const signal = new AbortController().signal;
	await git.prepare(attempt, signal);
	await writeFile(join(attempt.worktree, "app.txt"), "worker\n");
	await git.verify(attempt, signal, join(f.root, "checks.log"));
	await git.commit(attempt, { outcome: "ready", summary: "Ready", commitMessage: "fix: update fixture" }, signal);
	await writeFile(join(f.repo, "other.txt"), "concurrent\n");
	await execute(f.repo, "git", ["add", "."]);
	await execute(f.repo, "git", ["commit", "-m", "feat: add concurrent fixture"]);
	await execute(f.repo, "git", ["push", "origin", "main"]);
	await expect(git.publish(attempt, signal)).rejects.toThrow("Base branch advanced");
	expect((await execute(f.remote, "git", ["show", "main:app.txt"])).stdout).toBe("before\n");
}, 20_000);

test("sensitive files and worker-created commits require human inspection", async () => {
	const f = await fixture();
	const git = new GitWork();
	const attempt = job(f.root, { settings: f.config, worktree: join(f.root, "worker") });
	const signal = new AbortController().signal;
	await git.prepare(attempt, signal);
	await writeFile(join(attempt.worktree, ".env"), "EXAMPLE=value\n");
	await expect(
		git.commit(attempt, { outcome: "ready", summary: "Ready", commitMessage: "fix: fixture" }, signal),
	).rejects.toThrow("sensitive");
	await rm(join(attempt.worktree, ".env"));
	await writeFile(join(attempt.worktree, "app.txt"), "worker\n");
	await execute(attempt.worktree, "git", ["add", "."]);
	await execute(attempt.worktree, "git", ["commit", "-m", "fix: worker commit"]);
	await expect(git.verify(attempt, signal, join(f.root, "log"))).rejects.toThrow("Worker changed HEAD");
}, 20_000);

test("draft publication uses explicit repository, base, head, and draft flag", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const git = new GitWork(async (_cwd, command, args) => {
		calls.push({ command, args });
		let stdout = "";
		if (args[0] === "remote") stdout = "git@github.com:example/project.git\n";
		if (args[0] === "rev-parse") stdout = "commit\n";
		if (command === "gh") stdout = "https://github.com/example/project/pull/1\n";
		return { stdout, stderr: "" };
	});
	const publication = await git.publish(job("/repo", { commit: "commit" }), new AbortController().signal);
	expect(publication).toContain("/pull/1");
	const gh = calls.find((call) => call.command === "gh")!;
	expect(gh.args).toContain("--draft");
	expect(gh.args).toContain("--base");
	expect(gh.args).toContain("github.com/example/project");
	expect(calls.some((call) => call.args.some((arg) => arg.startsWith("--force")))).toBe(false);
	expect(githubRepo("ssh://git@github.com/example/project.git")).toBe("github.com/example/project");
	expect(() => githubRepo("https://token@github.com/example/project.git")).toThrow();
});

test("command execution reports failures and stops timed-out or aborted process groups", async () => {
	const root = await temporaryRoot();
	roots.push(root);
	await expect(execute(root, "sh", ["-c", "echo failure >&2; exit 3"])).rejects.toThrow("failure");
	await expect(execute(root, "sh", ["-c", "sleep 30"], { timeout: 30 })).rejects.toThrow("timed out");
	const abort = new AbortController();
	const running = execute(root, "sh", ["-c", "sleep 30"], { signal: abort.signal });
	abort.abort();
	await expect(running).rejects.toThrow("stopped");
}, 5000);
