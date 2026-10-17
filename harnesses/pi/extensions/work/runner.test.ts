import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { GitWork } from "./git";
import { FakeLinear, issue, settings, temporaryRoot } from "./fixtures.test-support";
import { eligible, pages, unblocked, unwrap } from "./linear";
import { WorkRunner } from "./runner";
import { WorkStore } from "./store";
import type { WorkerPort } from "./types";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(issues = [issue()]) {
	const root = await temporaryRoot();
	directories.push(root);
	const store = new WorkStore(join(root, "state"));
	const linear = new FakeLinear(issues);
	const events: string[] = [];
	const git = new GitWork();
	git.checkRemote = async () => {};
	git.preflight = async () => {};
	git.prepare = async (job) => {
		events.push("prepare");
		job.baseSha = "base";
	};
	git.verify = async () => {
		events.push("verify");
	};
	git.commit = async (job) => {
		events.push("commit");
		job.commit = "commit";
	};
	git.publish = async () => {
		events.push("publish");
		return "https://github.com/example/project/pull/1";
	};
	const worker: WorkerPort = {
		async run() {
			events.push("worker");
			return {
				outcome: "ready",
				summary: "Implemented example",
				commitMessage: "feat: implement example\n\nProvide the requested behavior.",
			};
		},
	};
	return { root, store, linear, events, git, worker, config: settings(root) };
}

test("eligibility is explicit and blockers must actually be completed", async () => {
	const config = settings("/repo");
	expect(eligible(issue(), config)).toBe(true);
	for (const changes of [
		{ assigneeId: "other" },
		{ projectId: "other" },
		{ statusType: "started" },
		{ labels: [] },
		{ archivedAt: "date" },
		{ statusType: "triage" },
	])
		expect(eligible(issue("DEV-1", changes), config)).toBe(false);
	const blocked = issue("DEV-1", { relations: { blockedBy: [{ id: "DEV-2" }] } });
	const linear = new FakeLinear([blocked, issue("DEV-2", { statusType: "canceled" })]);
	expect(await unblocked(linear, blocked)).toBe(false);
	linear.issues[1]!.statusType = "completed";
	expect(await unblocked(linear, blocked)).toBe(true);
	await expect(unblocked(linear, issue("DEV-3", { relations: undefined }))).rejects.toThrow("Dependency information");
});

test("selection orders by priority, rechecks details, and skips previous attempts", async () => {
	const f = await fixture([issue("DEV-1"), issue("DEV-2", { priority: 1 }), issue("DEV-3", { priority: 2 })]);
	const runner = new WorkRunner(f.store, f.linear, f.worker, f.git);
	expect((await runner.candidate(f.config))?.id).toBe("DEV-2");
	f.linear.workflow.reverse();
	await runner.run(f.config, false, "session");
	expect(f.linear.calls.find((call) => call.name === "save_issue")?.args.state).toBe("started");
	expect((await runner.candidate(f.config))?.id).toBe("DEV-3");
	expect((await f.store.job("DEV-2"))?.phase).toBe("awaiting-review");
	expect(f.events).toEqual(["prepare", "worker", "verify", "commit", "publish"]);
	expect(f.linear.issues[1]!.statusType).toBe("started");
	expect(f.linear.issues[1]!.status).toBe("In Review");
	expect(await f.store.owner()).toBeUndefined();
});

test("direct push completes only after successful publication and independent checks", async () => {
	const f = await fixture();
	f.config.publish = "direct-push";
	await new WorkRunner(f.store, f.linear, f.worker, f.git).run(f.config, false, "session");
	expect(f.linear.issues[0]!.statusType).toBe("completed");
	expect((await f.store.job("DEV-1"))?.phase).toBe("done");
	expect(f.events.indexOf("verify")).toBeLessThan(f.events.indexOf("publish"));
});

test("verification and worker failures preserve attempts and never publish", async () => {
	for (const failure of ["worker", "verify"]) {
		const f = await fixture();
		if (failure === "worker")
			f.worker.run = async () => ({ outcome: "needs-input", summary: "Need requirements", commitMessage: "" });
		else
			f.git.verify = async () => {
				throw new Error("Checks failed");
			};
		const runner = new WorkRunner(f.store, f.linear, f.worker, f.git);
		await runner.run(f.config, false, "session");
		expect((await f.store.job("DEV-1"))?.phase).toBe("needs-input");
		expect(f.events).not.toContain("publish");
		expect(await runner.candidate(f.config)).toBeUndefined();
	}
});

test("ownership changes and newly added blockers prevent publication", async () => {
	const f = await fixture();
	f.git.verify = async () => {
		f.linear.issues[0]!.assigneeId = "other";
	};
	await new WorkRunner(f.store, f.linear, f.worker, f.git).run(f.config, false, "session");
	expect(f.events).not.toContain("publish");
	expect((await f.store.job("DEV-1"))?.error).toContain("Issue changed");
});

test("changed requirements or withdrawn readiness prevent publication", async () => {
	for (const change of ["requirements", "label"]) {
		const f = await fixture();
		f.git.verify = async () => {
			if (change === "requirements") f.linear.issues[0]!.description = "Different requirements";
			else f.linear.issues[0]!.labels = [];
		};
		await new WorkRunner(f.store, f.linear, f.worker, f.git).run(f.config, false, "session");
		expect(f.events).not.toContain("publish");
		expect((await f.store.job("DEV-1"))?.phase).toBe("needs-input");
	}
});

test("sync never reopens an issue that a human has already completed", async () => {
	const f = await fixture();
	const runner = new WorkRunner(f.store, f.linear, f.worker, f.git);
	await runner.run(f.config, false, "session");
	f.linear.issues[0]!.statusType = "completed";
	f.linear.issues[0]!.status = "Done";
	await runner.sync((await f.store.job("DEV-1"))!);
	expect(f.linear.issues[0]!.statusType).toBe("completed");
	expect((await f.store.job("DEV-1"))?.phase).toBe("done");
});

test("a lost publication response stops the loop and excludes automatic retries", async () => {
	const f = await fixture([issue("DEV-1"), issue("DEV-2")]);
	f.git.publish = async () => {
		throw new Error("Connection lost after push");
	};
	await new WorkRunner(f.store, f.linear, f.worker, f.git).run(f.config, true, "session");
	expect((await f.store.job("DEV-1"))?.phase).toBe("needs-input");
	expect(await f.store.job("DEV-2")).toBeUndefined();
	await expect(f.store.archiveJob("DEV-1")).rejects.toThrow("already be published");
});

test("failed Linear sync records confirmed publication without republishing", async () => {
	const f = await fixture();
	f.linear.before = (name) => {
		if (name === "save_comment") throw new Error("Linear offline");
	};
	const runner = new WorkRunner(f.store, f.linear, f.worker, f.git);
	await runner.run(f.config, false, "session");
	const saved = (await f.store.job("DEV-1"))!;
	expect(saved.phase).toBe("published-needs-sync");
	f.linear.before = undefined;
	await runner.sync(saved);
	expect((await f.store.job("DEV-1"))?.phase).toBe("awaiting-review");
	expect(f.events.filter((event) => event === "publish")).toHaveLength(1);
});

test("pause finishes one ticket; stop interrupts and preserves its work", async () => {
	for (const action of ["pause", "stop"] as const) {
		const f = await fixture([issue("DEV-1"), issue("DEV-2")]);
		const runner = new WorkRunner(f.store, f.linear, f.worker, f.git);
		f.worker.run = async (_job, signal) => {
			runner[action]();
			signal.throwIfAborted();
			return { outcome: "ready", summary: "Ready", commitMessage: "fix: implement example" };
		};
		await runner.run(f.config, true, "session");
		expect((await f.store.job("DEV-1"))?.phase).toBe(action === "pause" ? "awaiting-review" : "interrupted");
		expect(await f.store.job("DEV-2")).toBeUndefined();
		expect(await f.store.owner()).toBeUndefined();
	}
});

test("an empty loop can be paused without waiting for the poll interval", async () => {
	const f = await fixture([]);
	let runner: WorkRunner;
	runner = new WorkRunner(
		f.store,
		f.linear,
		f.worker,
		f.git,
		(status) => {
			if (status.phase === "waiting") queueMicrotask(() => runner.pause());
		},
		60_000,
	);
	await runner.run(f.config, true, "session");
	expect(await f.store.owner()).toBeUndefined();
}, 2000);

test("MCP envelopes and paginated lists are decoded without dropping pages", async () => {
	expect(unwrap({ content: [{ type: "text", text: '{"id":"user"}' }] })).toEqual({ id: "user" });
	expect(() => unwrap({ isError: true, content: [] })).toThrow();
	let page = 0;
	const linear = {
		call: async () =>
			page++ ? { issues: [2], hasNextPage: false } : { issues: [1], hasNextPage: true, cursor: "next" },
	};
	expect(await pages(linear as any, "list_issues", "issues", {})).toEqual([1, 2]);
});
