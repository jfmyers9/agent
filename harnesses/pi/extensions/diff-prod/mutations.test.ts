import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalApplyPatch } from "../apply-patch/backend";
import { executeReplace } from "../fileops/index";
import { type FileMutation, MAX_MUTATION_TEXT, observeFileMutation } from "../shared/file-mutations";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "pi-mutations-"));
	directories.push(path);
	return path;
}

test("captures exact raw text at writes, bounded snapshots and unknown failed writes", async () => {
	const cwd = await directory();
	const path = join(cwd, "a");
	const changes: FileMutation[] = [];
	const report = (change: FileMutation) => {
		changes.push(change);
	};
	await observeFileMutation(path, "\ufeffone\r\n", () => writeFile(path, "\ufeffone\r\n"), report);
	await observeFileMutation(path, "two\n", () => writeFile(path, "two\n"), report);
	expect(changes).toEqual([
		{ path, before: null, after: "\ufeffone\r\n" },
		{ path, before: "\ufeffone\r\n", after: "two\n" },
	]);
	await expect(
		observeFileMutation(
			path,
			"three\n",
			async () => {
				throw new Error("failed");
			},
			report,
		),
	).rejects.toThrow("failed");
	expect(changes.at(-1)).toEqual({ path, before: "two\n", after: undefined });
	const large = "a".repeat(MAX_MUTATION_TEXT + 1);
	await writeFile(path, large);
	await observeFileMutation(path, "small\n", () => writeFile(path, "small\n"), report);
	expect(changes.at(-1)).toEqual({ path, before: undefined, after: "small\n" });
});

test("apply_patch reports committed paths, including partial moves, but not dry runs or failed preflights", async () => {
	const cwd = await directory();
	const source = join(cwd, "source");
	await writeFile(source, "one\n");
	const changes: FileMutation[] = [];
	const options = {
		onMutation: (change: FileMutation) => {
			changes.push(change);
		},
	};
	await runLocalApplyPatch(cwd, "*** Begin Patch\n*** Delete File: source\n*** End Patch", {
		...options,
		dryRun: true,
	});
	expect(changes).toEqual([]);
	await expect(
		runLocalApplyPatch(
			cwd,
			"*** Begin Patch\n*** Delete File: source\n*** Delete File: absent\n*** End Patch",
			options,
		),
	).rejects.toThrow();
	expect(changes).toEqual([]);
	await writeFile(join(cwd, "blocked"), "not a directory");
	await expect(
		runLocalApplyPatch(cwd, "*** Begin Patch\n*** Move File: source -> blocked/target\n*** End Patch", options),
	).rejects.toThrow();
	expect(changes).toEqual([{ path: source, before: "one\n", after: null }]);
	await expect(readFile(source)).rejects.toThrow();
});

test("both replace-mode paths report exact mutations without leaking extra snapshots", async () => {
	const cwd = await directory();
	const path = join(cwd, "a");
	await writeFile(path, "\ufeffone\r\none\r\n");
	const changes: FileMutation[] = [];
	const report = (mutation: FileMutation) => {
		changes.push(mutation);
	};
	const config = { mode: "replace" as const, fuzzyMatch: true, fuzzyThreshold: 0.95, allowReplaceAll: true };
	const result = await executeReplace(
		cwd,
		{ path: "a", oldText: "one\none", newText: "two\none" },
		config,
		undefined,
		report,
	);
	expect(result.details).not.toHaveProperty("before");
	expect(changes).toEqual([{ path, before: "\ufeffone\r\none\r\n", after: "\ufefftwo\r\none\r\n" }]);
	await executeReplace(cwd, { path: "a", oldText: "one", newText: "two", all: true }, config, undefined, report);
	expect(changes.at(-1)).toEqual({ path, before: "\ufefftwo\r\none\r\n", after: "\ufefftwo\r\ntwo\r\n" });
	const count = changes.length;
	await expect(
		executeReplace(cwd, { path: "a", oldText: "missing", newText: "no" }, config, undefined, report),
	).rejects.toThrow();
	expect(changes).toHaveLength(count);
});
