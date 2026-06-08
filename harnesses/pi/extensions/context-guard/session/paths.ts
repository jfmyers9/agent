import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";

let _wtCache: { projectDir: string; envSuffix: string | undefined; suffix: string } | undefined;

export function normalizeWorktreePath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	if (/^\/+$/.test(normalized)) return "/";
	if (/^[A-Za-z]:\/+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
	return normalized.replace(/\/+$/, "");
}

function canonicalizeForCompare(root: string): string {
	let resolved = root;
	try {
		resolved = realpathSync.native(root);
	} catch {
		// best-effort
	}
	const normalized = normalizeWorktreePath(resolved);
	if (process.platform === "win32" || process.platform === "darwin") {
		return normalized.toLowerCase();
	}
	return normalized;
}

function gitOutput(projectDir: string, args: string[]): string {
	return execFileSync("git", ["-C", projectDir, ...args], {
		encoding: "utf-8",
		timeout: 2000,
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function getCurrentWorktreeRoot(projectDir: string): string | null {
	const root = gitOutput(projectDir, ["rev-parse", "--show-toplevel"]);
	return root.length > 0 ? normalizeWorktreePath(root) : null;
}

function getMainWorktreeRoot(projectDir: string): string | null {
	const root = gitOutput(projectDir, ["worktree", "list", "--porcelain"])
		.split(/\r?\n/)
		.find((line) => line.startsWith("worktree "))
		?.replace("worktree ", "")
		?.trim();
	return root ? normalizeWorktreePath(root) : null;
}

export function getWorktreeSuffix(projectDir = process.cwd()): string {
	const envSuffix = process.env.CONTEXT_GUARD_SESSION_SUFFIX;
	if (_wtCache && _wtCache.projectDir === projectDir && _wtCache.envSuffix === envSuffix) {
		return _wtCache.suffix;
	}

	let suffix = "";
	if (envSuffix !== undefined) {
		suffix = envSuffix ? `__${envSuffix}` : "";
	} else {
		try {
			const currentRoot = getCurrentWorktreeRoot(projectDir);
			const mainRoot = getMainWorktreeRoot(projectDir);
			if (currentRoot && mainRoot) {
				const canonicalCurrent = canonicalizeForCompare(currentRoot);
				const canonicalMain = canonicalizeForCompare(mainRoot);
				if (canonicalCurrent !== canonicalMain) {
					suffix = `__${createHash("sha256").update(canonicalCurrent).digest("hex").slice(0, 8)}`;
				}
			}
		} catch {
			// git unavailable or not a repo
		}
	}

	_wtCache = { projectDir, envSuffix, suffix };
	return suffix;
}

export function _resetWorktreeSuffixCacheForTests(): void {
	_wtCache = undefined;
}

export function hashProjectDirLegacy(projectDir: string): string {
	return createHash("sha256").update(normalizeWorktreePath(projectDir)).digest("hex").slice(0, 16);
}

export function hashProjectDirCanonical(projectDir: string): string {
	const normalized = normalizeWorktreePath(projectDir);
	const folded = process.platform === "darwin" || process.platform === "win32" ? normalized.toLowerCase() : normalized;
	return createHash("sha256").update(folded).digest("hex").slice(0, 16);
}

export function resolveContentStorePath(opts: { projectDir: string; contentDir: string }): string {
	const { projectDir, contentDir } = opts;
	const canonicalHash = hashProjectDirCanonical(projectDir);
	const canonicalPath = join(contentDir, `${canonicalHash}.db`);
	if (existsSync(canonicalPath)) return canonicalPath;

	const legacyHash = hashProjectDirLegacy(projectDir);
	if (legacyHash === canonicalHash) return canonicalPath;

	const legacyPath = join(contentDir, `${legacyHash}.db`);
	if (existsSync(legacyPath)) {
		try {
			renameSync(legacyPath, canonicalPath);
			for (const suffix of ["-wal", "-shm"]) {
				try {
					renameSync(legacyPath + suffix, canonicalPath + suffix);
				} catch {}
			}
		} catch {
			// best-effort
		}
	}
	return canonicalPath;
}

export function resolveSessionDbPath(opts: { projectDir: string; sessionsDir: string }): string {
	return resolveSessionPath({ ...opts, ext: ".db" });
}

export function resolveSessionPath(opts: {
	projectDir: string;
	sessionsDir: string;
	ext: string;
	suffix?: string;
}): string {
	const { projectDir, sessionsDir, ext } = opts;
	const suffix = opts.suffix ?? getWorktreeSuffix(projectDir);
	const canonicalHash = hashProjectDirCanonical(projectDir);
	const canonicalPath = join(sessionsDir, `${canonicalHash}${suffix}${ext}`);
	if (existsSync(canonicalPath)) return canonicalPath;

	const legacyHash = hashProjectDirLegacy(projectDir);
	if (legacyHash === canonicalHash) return canonicalPath;

	const legacyPath = join(sessionsDir, `${legacyHash}${suffix}${ext}`);
	if (existsSync(legacyPath)) {
		try {
			renameSync(legacyPath, canonicalPath);
		} catch {
			// best-effort
		}
	}
	return canonicalPath;
}
