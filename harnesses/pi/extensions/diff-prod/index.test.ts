import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_EXCLUDES, loadExcludes, readDiff } from "./git";
import diffProd from "./index";
import { DiffView } from "./view";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function repo() {
	const root = mkdtempSync(join(tmpdir(), "pi-diff-prod-"));
	dirs.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	return root;
}
function git(root: string, ...args: string[]) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}
function put(root: string, file: string, text: string) {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), text);
}
const executor = {
	exec: async (cmd: string, args: string[], options: { cwd: string }) => {
		const result = spawnSync(cmd, args, { cwd: options.cwd, encoding: "utf8" });
		return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1, killed: false };
	},
} as Pick<ExtensionAPI, "exec">;

test("repository-wide staged and unstaged diff excludes tests and untracked files", async () => {
	const root = repo();
	const files = [
		"src/app.ts",
		"root.ts",
		"tests/a.ts",
		"nested/tests/a.ts",
		"src/a.test.ts",
		"a.spec.ts",
		"test_a.py",
		"pkg/a_test.go",
		"__fixtures__/data.json",
	];
	for (const file of files) put(root, file, "before\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "initial");
	for (const file of files) put(root, file, "after\n");
	git(root, "add", "root.ts");
	put(root, "new.ts", "untracked\n");
	const diff = await readDiff(executor, join(root, "src"));
	expect(diff).toContain("a/src/app.ts");
	expect(diff).toContain("a/root.ts");
	for (const file of files.slice(2)) expect(diff).not.toContain(`a/${file}`);
	expect(diff).not.toContain("new.ts");
	expect(diff).toContain("+after");
});

test("unborn HEAD, deleted files, and paths containing spaces are supported", async () => {
	const root = repo();
	put(root, "src/space name.ts", "hello\n");
	git(root, "add", ".");
	expect(await readDiff(executor, root)).toContain("+hello");
	git(root, "commit", "-qm", "initial");
	rmSync(join(root, "src/space name.ts"));
	expect(await readDiff(executor, root)).toContain("-hello");
});

test("clean repo, custom exclusions replacing defaults, and invalid config", async () => {
	const root = repo();
	put(root, "app.ts", "before\n");
	put(root, "app.test.ts", "before\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "initial");
	expect(await readDiff(executor, root)).toBe("");
	expect(await loadExcludes(root)).toEqual(DEFAULT_EXCLUDES);
	put(root, "app.ts", "after\n");
	put(root, "app.test.ts", "after\n");
	put(root, ".pi/diff-prod.json", JSON.stringify({ exclude: ["app.ts"] }));
	const diff = await readDiff(executor, root);
	expect(diff).toContain("a/app.test.ts");
	expect(diff).not.toContain("a/app.ts");
	put(root, ".pi/diff-prod.json", '{"exclude":[42]}');
	await expect(loadExcludes(root)).rejects.toThrow("expected");
	put(root, ".pi/diff-prod.json", "{");
	await expect(loadExcludes(root)).rejects.toThrow();
});

test("Git failures and timeouts never display a partial diff", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-diff-prod-"));
	dirs.push(root);
	await expect(readDiff(executor, root)).rejects.toThrow();
	const killed = { exec: async () => ({ stdout: "partial", stderr: "", code: 0, killed: true }) };
	await expect(readDiff(killed, root)).rejects.toThrow("timed out");
});

test("viewer scrolls, pans, clamps after resizing, strips controls, and closes", () => {
	let rows = 10;
	let renders = 0;
	let closed = false;
	const theme = { fg: (_color: string, text: string) => text } as Theme;
	const view = new DiffView(
		Array.from({ length: 40 }, (_, i) => `+${i} 界${"x".repeat(100)}\x1b[2J`).join("\n"),
		theme,
		() => rows,
		() => renders++,
		() => {
			closed = true;
		},
	);
	let lines = view.render(30);
	expect(lines[1]).toStartWith("+0");
	view.handleInput("j");
	expect(view.render(30)[1]).toStartWith("+1");
	view.handleInput("G");
	expect(view.render(30)[1]).toStartWith("+34");
	view.handleInput("l");
	expect(view.render(30)[1]).not.toStartWith("+");
	rows = 20;
	lines = view.render(160);
	expect(lines[1]).toStartWith("+24");
	expect(lines.join("\n")).not.toContain("\x1b");
	for (const width of [1, 2, 20, 80])
		for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	view.handleInput("g");
	expect(view.render(160)[1]).toStartWith("+0");
	view.handleInput("q");
	expect(closed).toBe(true);
	expect(renders).toBeGreaterThan(0);
});

test("command handles missing UI, usage, empty diff, and Git errors", async () => {
	let handler: any;
	diffProd({
		...executor,
		on() {},
		registerShortcut() {},
		registerCommand(name: string, command: any) {
			expect(name).toBe("diff-prod");
			handler = command.handler;
		},
	} as ExtensionAPI);
	const messages: string[] = [];
	const ctx = {
		hasUI: false,
		cwd: repo(),
		ui: {
			notify: (s: string) => messages.push(s),
			custom: () => {
				throw new Error("unexpected view");
			},
		},
	};
	await handler("", ctx);
	expect(messages.pop()).toContain("interactive");
	ctx.hasUI = true;
	await handler("invalid", ctx);
	expect(messages.pop()).toContain("Usage");
	await handler("", ctx);
	expect(messages.pop()).toContain("No production changes");
	ctx.cwd = join(ctx.cwd, "missing");
	await handler("", ctx);
	expect(messages.pop()).toContain("failed");
});
