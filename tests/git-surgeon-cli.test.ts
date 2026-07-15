import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve(import.meta.dir, "../bin/git-surgeon.ts");
const textFile = "notes file.txt";

type ListedHunk = {
  id: string;
  view: "staged" | "unstaged";
  file: string;
  header: string;
};

type ListOutput = {
  hunks: ListedHunk[];
  rejected: Array<{ view: string; file: string; reason: string }>;
};

let root: string;

function command(program: string, args: string[]) {
  return spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Git Surgeon Test",
      GIT_AUTHOR_EMAIL: "git-surgeon@example.test",
      GIT_COMMITTER_NAME: "Git Surgeon Test",
      GIT_COMMITTER_EMAIL: "git-surgeon@example.test",
    },
  });
}

function git(...args: string[]) {
  const result = command("git", args);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

function surgeon(...args: string[]) {
  return command(cli, args);
}

function list(view: "staged" | "unstaged" | "all" = "all"): ListOutput {
  const result = surgeon("list", "--view", view, "--json");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as ListOutput;
}

function content(changes: Record<number, string> = {}): string {
  return `${Array.from({ length: 30 }, (_, index) => changes[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;
}

function writeText(changes: Record<number, string> = {}): void {
  writeFileSync(join(root, textFile), content(changes));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-surgeon-cli-"));
  git("init", "-b", "main");
  writeText();
  git("add", textFile);
  git("commit", "-m", "initial");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("selective operations", () => {
  test("lists, shows, stages, unstages, and explicitly discards fresh hunks", () => {
    writeText({ 2: "line 2 first", 24: "line 24 second" });

    const initial = list("unstaged");
    expect(initial.hunks).toHaveLength(2);
    expect(initial.hunks.every((hunk) => /^[0-9a-f]{10}(?:-\d+)?$/.test(hunk.id))).toBe(true);
    expect(initial.hunks.every((hunk) => hunk.file === textFile)).toBe(true);

    const first = initial.hunks.find((hunk) => hunk.header.startsWith("@@ -1,"))!;
    const shown = surgeon("show", first.id, "--view", "unstaged", "--json");
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).hunk.content).toContain("+line 2 first");

    const staged = surgeon("stage", first.id, "--json");
    expect(staged.status).toBe(0);
    expect(JSON.parse(staged.stdout)).toEqual({
      operation: "stage",
      ids: [first.id],
      files: [textFile],
    });
    expect(git("diff", "--cached", "--", textFile)).toContain("+line 2 first");
    expect(git("diff", "--cached", "--", textFile)).not.toContain("line 24 second");
    expect(git("diff", "--", textFile)).toContain("+line 24 second");
    expect(git("diff", "--", textFile)).not.toContain("line 2 first");

    const stagedFirst = list("staged").hunks.find((hunk) => hunk.header.startsWith("@@ -1,"))!;
    expect(surgeon("unstage", stagedFirst.id).status).toBe(0);
    expect(git("diff", "--cached", "--", textFile)).toBe("");

    const freshFirst = list("unstaged").hunks.find((hunk) => hunk.header.startsWith("@@ -1,"))!;
    const before = readFileSync(join(root, textFile), "utf8");
    const unapproved = surgeon("discard", freshFirst.id);
    expect(unapproved.status).toBe(2);
    expect(unapproved.stderr).toContain("pass --yes");
    expect(readFileSync(join(root, textFile), "utf8")).toBe(before);

    expect(surgeon("discard", "--yes", freshFirst.id).status).toBe(0);
    expect(readFileSync(join(root, textFile), "utf8")).toBe(content({ 24: "line 24 second" }));
    expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("preserves unrelated staged and unstaged hunks", () => {
    writeText({ 12: "line 12 already staged" });
    git("add", textFile);
    writeText({ 2: "line 2 selected", 12: "line 12 already staged", 24: "line 24 untouched" });

    const selected = list("unstaged").hunks.find((hunk) => hunk.header.startsWith("@@ -1,"))!;
    expect(surgeon("stage", selected.id).status).toBe(0);

    const cached = git("diff", "--cached", "--", textFile);
    const unstaged = git("diff", "--", textFile);
    expect(cached).toContain("+line 2 selected");
    expect(cached).toContain("+line 12 already staged");
    expect(cached).not.toContain("line 24 untouched");
    expect(unstaged).toContain("+line 24 untouched");
    expect(unstaged).not.toContain("line 2 selected");
  });

  test("rejects stale IDs atomically", () => {
    writeText({ 2: "line 2 first", 24: "line 24 second" });
    const initial = list("unstaged");
    const stale = initial.hunks.find((hunk) => hunk.header.startsWith("@@ -1,"))!;
    const stillFresh = initial.hunks.find((hunk) => hunk.header.includes("-21,"))!;

    writeText({ 2: "line 2 changed again", 24: "line 24 second" });
    const result = surgeon("stage", stillFresh.id, stale.id);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found in fresh unstaged snapshot");
    expect(git("diff", "--cached")).toBe("");
    expect(git("diff", "--", textFile)).toContain("+line 24 second");
  });

  test("treats pathspec metacharacters as literal filenames", () => {
    const literal = "*.txt";
    const victim = "victim.txt";
    writeFileSync(join(root, literal), content());
    writeFileSync(join(root, victim), content());
    git("add", literal, victim);
    git("commit", "-m", "pathspec fixtures");

    writeFileSync(join(root, literal), content({ 2: "literal staged", 24: "literal discarded" }));
    writeFileSync(join(root, victim), content({ 2: "victim untouched" }));

    const initial = list("unstaged");
    const literalHunks = initial.hunks.filter((hunk) => hunk.file === literal);
    expect(literalHunks).toHaveLength(2);
    expect(initial.hunks.filter((hunk) => hunk.file === victim)).toHaveLength(1);

    const first = literalHunks.find((hunk) => hunk.header.startsWith("@@ -1,"))!;
    expect(surgeon("stage", first.id).status).toBe(0);
    expect(git("diff", "--cached", "--name-only", "-z")).toBe("*.txt\0");

    const second = list("unstaged").hunks.find((hunk) => hunk.file === literal && hunk.header.includes("-21,"))!;
    expect(surgeon("discard", "--yes", second.id).status).toBe(0);

    expect(readFileSync(join(root, literal), "utf8")).toBe(content({ 2: "literal staged" }));
    expect(readFileSync(join(root, victim), "utf8")).toBe(content({ 2: "victim untouched" }));
    expect(git("diff", "--name-only", "-z")).toBe("victim.txt\0");
  });
});

describe("eligibility", () => {
  test("reports unsupported files without blocking eligible text hunks", () => {
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "deleted.txt"), "delete me\n");
    writeFileSync(join(root, "renamed.txt"), "rename me\n");
    writeFileSync(join(root, "mode.txt"), "mode\n");
    writeFileSync(join(root, "type.txt"), "regular\n");
    symlinkSync("target-one", join(root, "link"));
    git("add", "binary.dat", "deleted.txt", "renamed.txt", "mode.txt", "type.txt", "link");
    git("commit", "-m", "fixtures");

    writeText({ 2: "line 2 eligible" });
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 9, 8, 7]));
    unlinkSync(join(root, "deleted.txt"));
    chmodSync(join(root, "mode.txt"), 0o755);
    unlinkSync(join(root, "link"));
    symlinkSync("target-two", join(root, "link"));
    unlinkSync(join(root, "type.txt"));
    symlinkSync("replacement", join(root, "type.txt"));
    git("mv", "renamed.txt", "moved.txt");
    writeFileSync(join(root, "added.txt"), "added\n");
    git("add", "added.txt");
    writeFileSync(join(root, "untracked.txt"), "untracked\n");
    const head = git("rev-parse", "HEAD").trim();
    git("update-index", "--add", "--cacheinfo", `160000,${head},submodule`);

    const current = list();
    expect(current.hunks).toHaveLength(1);
    expect(current.hunks[0]?.file).toBe(textFile);
    const reasons = new Map(current.rejected.map((item) => [item.file, item.reason]));
    expect(reasons.get("binary.dat")).toBe("binary file");
    expect(reasons.get("deleted.txt")).toBe("deleted file");
    expect(reasons.get("mode.txt")).toBe("file mode change");
    expect(reasons.get("link")).toBe("non-regular file");
    expect(reasons.get("type.txt")).toBe("file type change");
    expect(reasons.get("renamed.txt -> moved.txt")).toBe("renamed file");
    expect(reasons.get("added.txt")).toBe("added file");
    expect(reasons.get("submodule")).toBe("submodule");
    expect(current.rejected.some((item) => item.file === "untracked.txt")).toBe(false);

    expect(surgeon("stage", current.hunks[0]!.id).status).toBe(0);
    expect(git("diff", "--cached", "--", textFile)).toContain("+line 2 eligible");
    expect(readFileSync(join(root, "binary.dat"))).toEqual(Buffer.from([0, 9, 8, 7]));
  });
});
