import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitStatus } from "./git";

const originalPath = process.env.PATH;
const cleanupPaths: string[] = [];

afterEach(() => {
	process.env.PATH = originalPath;
	delete process.env.PI_TUI_GIT_TEST_LOG;
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

test("readGitStatus disables optional locks for all git subprocesses", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-git-"));
	cleanupPaths.push(root);
	const bin = join(root, "bin");
	const log = join(root, "git.log");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "git"),
		[
			"#!/bin/sh",
			'printf "%s|%s\\n" "$GIT_OPTIONAL_LOCKS" "$*" >> "$PI_TUI_GIT_TEST_LOG"',
			'if [ "$1" = "status" ]; then',
			'  printf "# branch.head main\\n1 .M N... 100644 100644 100644 abc abc file.txt\\n"',
			"fi",
		].join("\n"),
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}:${originalPath}`;
	process.env.PI_TUI_GIT_TEST_LOG = log;

	const status = await readGitStatus(root);

	expect(status.branch).toBe("main");
	expect(status.modified).toBe(1);
	const calls = readFileSync(log, "utf8").trim().split("\n").sort();
	expect(calls).toEqual(["0|rev-parse --verify --quiet refs/stash", "0|status --porcelain=2 --branch"]);
});
