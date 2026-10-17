import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { WorkJob, WorkSettings } from "./types.js";

export const workStateDir = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agent-work");
export const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
interface Owner {
	pid: number;
	host: string;
	token: string;
	session: string;
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class WorkStore {
	constructor(readonly root = workStateDir()) {}
	private async write(path: string, value: unknown): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	}
	settings(commonDir: string) {
		return readJson<WorkSettings>(join(this.root, `settings-${key(commonDir)}.json`));
	}
	saveSettings(settings: WorkSettings) {
		return this.write(join(this.root, `settings-${key(settings.commonDir)}.json`), settings);
	}
	job(id: string) {
		return readJson<WorkJob>(join(this.root, `job-${key(id)}.json`));
	}
	saveJob(job: WorkJob) {
		job.updatedAt = new Date().toISOString();
		return this.write(join(this.root, `job-${key(job.issueId)}.json`), job);
	}
	async jobs(): Promise<WorkJob[]> {
		const files = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const jobs = await Promise.all(
			files.filter((file) => /^job-.*\.json$/.test(file)).map((file) => readJson<WorkJob>(join(this.root, file))),
		);
		return jobs.filter((job): job is WorkJob => !!job).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	async archiveJob(id: string): Promise<void> {
		const job = await this.job(id);
		if (!job) throw new Error(`No saved attempt for ${id}.`);
		if (job.commit || job.publication || ["publishing", "published", "published-needs-sync"].includes(job.phase)) {
			throw new Error(
				"This attempt may already be published. Reconcile it manually; retry would risk duplicate publication.",
			);
		}
		await rename(join(this.root, `job-${key(id)}.json`), join(this.root, `attempt-${job.runId}.json`));
	}
	owner() {
		return readJson<Owner>(join(this.root, "lock", "owner.json"));
	}
	async lock(session: string): Promise<() => Promise<void>> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const path = join(this.root, "lock");
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = await this.owner();
			throw new Error(
				`A work runner already owns the local queue${owner ? ` (PID ${owner.pid}, session ${owner.session})` : ""}. Use /work status; after a crash use /work recover.`,
			);
		}
		const owner: Owner = { pid: process.pid, host: hostname(), token: randomUUID(), session };
		try {
			await writeFile(join(path, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
		} catch (error) {
			await rm(path, { recursive: true });
			throw error;
		}
		return async () => {
			if ((await this.owner())?.token === owner.token) await rm(path, { recursive: true });
		};
	}
	async recover(): Promise<void> {
		const owner = await this.owner();
		if (!owner)
			throw new Error(
				"No recoverable owner record. Do not remove an incomplete lock while another runner may be starting.",
			);
		if (owner.host !== hostname())
			throw new Error("The lock belongs to another host; distributed recovery is not supported.");
		try {
			process.kill(owner.pid, 0);
			throw new Error(`PID ${owner.pid} is still alive. Stop its runner before recovering.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		// No automatic restart: a crashed publisher may have succeeded remotely.
		for (const job of await this.jobs()) {
			if (["claiming", "implementing", "verifying"].includes(job.phase)) {
				job.phase = "interrupted";
				job.error = "Runner exited. Worktree preserved; inspect before retrying.";
				await this.saveJob(job);
			}
		}
		if ((await this.owner())?.token !== owner.token) throw new Error("Lock owner changed during recovery.");
		await rm(join(this.root, "lock"), { recursive: true });
	}
}
