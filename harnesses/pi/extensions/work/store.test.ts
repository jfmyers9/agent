import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { job, settings, temporaryRoot } from "./fixtures.test-support";
import { WorkStore } from "./store";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function store() {
	const root = await temporaryRoot();
	roots.push(root);
	return new WorkStore(join(root, "state"));
}

test("settings and attempts persist outside the repository with private permissions", async () => {
	const s = await store();
	const config = settings("/repo");
	await s.saveSettings(config);
	expect(await new WorkStore(s.root).settings(config.commonDir)).toEqual(config);
	await s.saveJob(job("/repo"));
	expect((await s.jobs())[0]?.issueId).toBe("DEV-1");
	expect((await stat(s.root)).mode & 0o777).toBe(0o700);
});

test("atomic local claims exclude another session and live locks cannot be recovered", async () => {
	const s = await store();
	const results = await Promise.allSettled([s.lock("one"), s.lock("two")]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	await expect(s.recover()).rejects.toThrow("still alive");
	for (const result of results) if (result.status === "fulfilled") await result.value();
	expect(await s.owner()).toBeUndefined();
});

test("crash recovery preserves uncertain publication and never automatically retries", async () => {
	const s = await store();
	await mkdir(join(s.root, "lock"), { recursive: true });
	// An implausible PID safely demonstrates a dead owner on supported POSIX hosts.
	await writeFile(
		join(s.root, "lock", "owner.json"),
		JSON.stringify({ pid: 2_147_483_647, host: hostname(), token: "dead", session: "old" }),
	);
	await s.saveJob(job("/repo"));
	await s.saveJob(job("/repo", { issueId: "DEV-2", phase: "publishing", commit: "sha" }));
	await s.recover();
	expect((await s.job("DEV-1"))?.phase).toBe("interrupted");
	expect((await s.job("DEV-2"))?.phase).toBe("publishing");
	await expect(s.archiveJob("DEV-2")).rejects.toThrow("already be published");
	await s.archiveJob("DEV-1");
	expect(await s.job("DEV-1")).toBeUndefined();
	expect(await readFile(join(s.root, "attempt-test-run.json"), "utf8")).toContain("DEV-1");
});
