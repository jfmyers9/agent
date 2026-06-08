import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionQuery } from "../session/core-session.js";
import { resolveContentStorePath, resolveSessionDbPath } from "../session/paths.js";
import { getPiSessionDir } from "./index.js";

let cachedSessionId: { sid: string; checkedAt: number } | undefined;

export function resolveSessionIdFromSessionDB(opts?: {
	projectDir?: string;
	sessionsDir?: string;
	bypassCache?: boolean;
}): string | undefined {
	const now = Date.now();
	if (!opts?.bypassCache && cachedSessionId && now - cachedSessionId.checkedAt < 2000) {
		return cachedSessionId.sid;
	}

	try {
		const projectDir = opts?.projectDir ?? getProjectDir();
		if (!projectDir) return undefined;
		const sessionsDir = opts?.sessionsDir ?? getSessionDir();
		const dbPath = resolveSessionDbPath({ projectDir, sessionsDir });
		const state = sessionQuery({ sessionDbPath: dbPath, latestSessionId: true });
		const sid = state?.latestSessionId;
		if (sid) cachedSessionId = { sid, checkedAt: now };
		return sid;
	} catch {
		return undefined;
	}
}

export function getSessionDir(): string {
	return getPiSessionDir();
}

export function getProjectDir(): string {
	const candidates = [
		process.env.PI_WORKSPACE_DIR,
		process.env.PI_PROJECT_DIR,
		process.env.CONTEXT_GUARD_PROJECT_DIR,
		process.env.PWD,
		process.cwd(),
	];

	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			const trimmed = candidate.trim();
			if (trimmed) return trimmed;
		}
	}

	return process.cwd();
}

export function getSessionDbPath(): string {
	return resolveSessionDbPath({
		projectDir: getProjectDir(),
		sessionsDir: getSessionDir(),
	});
}

export function getStorePath(): string {
	const dir = join(dirname(getSessionDir()), "content");
	mkdirSync(dir, { recursive: true });
	return resolveContentStorePath({ projectDir: getProjectDir(), contentDir: dir });
}
