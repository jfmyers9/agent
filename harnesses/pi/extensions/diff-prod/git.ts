import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_EXCLUDES = [
	"**/test/**",
	"**/tests/**",
	"**/__tests__/**",
	"**/spec/**",
	"**/specs/**",
	"**/fixtures/**",
	"**/__fixtures__/**",
	"**/__snapshots__/**",
	"**/*.test.*",
	"**/*.spec.*",
	"**/test_*",
	"**/*_test.*",
	"**/*_spec.*",
];

export async function loadExcludes(root: string): Promise<string[]> {
	const path = join(root, ".pi", "diff-prod.json");
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...DEFAULT_EXCLUDES];
		throw error;
	}
	const config = JSON.parse(source);
	if (
		!config ||
		!Array.isArray(config.exclude) ||
		!config.exclude.every((p: unknown) => typeof p === "string" && p.length > 0)
	) {
		throw new Error(`${path}: expected { "exclude": ["glob", ...] }`);
	}
	return config.exclude;
}

export function diffArgs(base: string, exclude: string[]): string[] {
	return [
		"--no-pager",
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--no-renames",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		base,
		"--",
		":(top)**",
		...exclude.map((pattern) => `:(top,glob,exclude)${pattern}`),
	];
}

export async function readDiff(pi: Pick<ExtensionAPI, "exec">, cwd: string): Promise<string> {
	async function git(args: string[], directory = cwd) {
		const result = await pi.exec("git", args, { cwd: directory, timeout: 30_000 });
		if (result.killed) throw new Error("Git timed out; no partial diff is displayed.");
		if (result.code !== 0) throw new Error(result.stderr.trim() || "Git command failed.");
		return result.stdout;
	}
	const root = (await git(["rev-parse", "--show-toplevel"])).trimEnd();
	const exclude = await loadExcludes(root);
	const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, timeout: 30_000 });
	if (head.killed) throw new Error("Git timed out.");
	// An unborn branch compares tracked files against the empty tree, without writing objects.
	const base = head.code === 0 ? "HEAD" : (await git(["hash-object", "-t", "tree", "--stdin"], root)).trim();
	return git(diffArgs(base, exclude), root);
}
