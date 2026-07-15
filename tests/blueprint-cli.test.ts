import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve(import.meta.dir, "../bin/blueprint");

let root: string;
let projectDir: string;
let blueprintDir: string;

function command(program: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      BLUEPRINT_DIR: blueprintDir,
      GIT_AUTHOR_NAME: "Blueprint Test",
      GIT_AUTHOR_EMAIL: "blueprint@example.test",
      GIT_COMMITTER_NAME: "Blueprint Test",
      GIT_COMMITTER_EMAIL: "blueprint@example.test",
      ...extraEnv,
    },
  });
}

function blueprint(...args: string[]) {
  return command(cli, args, projectDir);
}

function blueprintWithEnv(env: Record<string, string>, ...args: string[]) {
  return command(cli, args, projectDir, env);
}

function quotedYaml(value: string) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}"`;
}

function artifactFile(
  type: "proposal" | "review" | "report" | "spec" | "plan",
  epoch: number,
  slug: string,
  kind?: string,
) {
  const dir = join(blueprintDir, basename(projectDir), type);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${epoch}-${slug}.md`);
  writeFileSync(
    file,
    `---\ntopic: "Fixture"\nproject: ${projectDir}\ncreated: 2024-01-01T00:00:00Z\nstatus: approved\n${kind ? `kind: ${kind}\n` : ""}---\n`,
  );
  return file;
}

function legacyFile(type: "spec" | "plan", epoch: number, slug: string) {
  return artifactFile(type, epoch, slug);
}

function git(...args: string[]) {
  return command("git", args, blueprintDir);
}

function exerciseConfiguredRoot(configuredRoot: string, topic: string) {
  const env = { BLUEPRINT_DIR: configuredRoot };
  const created = blueprintWithEnv(env, "create", "proposal", topic);
  expect(created.status).toBe(0);
  const file = created.stdout.trim();
  expect(file.startsWith(`${blueprintDir}/`)).toBe(true);

  const found = blueprintWithEnv(env, "find", "--type", "proposal", "--exact", file);
  expect(found.status).toBe(0);
  expect(found.stdout.trim()).toBe(file);
  expect(blueprintWithEnv(env, "commit", "proposal", file).status).toBe(0);

  const archived = blueprintWithEnv(env, "archive", file);
  expect(archived.status).toBe(0);
  expect(archived.stdout.split("\n")[0]).toBe(join(blueprintDir, basename(projectDir), "archive", basename(file)));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blueprint-cli-"));
  projectDir = join(root, "fixture");
  blueprintDir = join(root, "blueprints");
  mkdirSync(projectDir);
  mkdirSync(blueprintDir);

  const remote = join(root, "remote.git");
  expect(command("git", ["init", "--bare", remote], root).status).toBe(0);
  expect(command("git", ["init", "-b", "main"], blueprintDir).status).toBe(0);
  expect(command("git", ["commit", "--allow-empty", "-m", "init"], blueprintDir).status).toBe(0);
  expect(command("git", ["remote", "add", "origin", remote], blueprintDir).status).toBe(0);
  expect(command("git", ["push", "-u", "origin", "main"], blueprintDir).status).toBe(0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("proposal lifecycle", () => {
  test("creates the proposal scaffold and advances supported states", () => {
    const created = blueprint("create", "proposal", "Opt in workflow");
    expect(created.status).toBe(0);
    const file = created.stdout.trim();
    const body = readFileSync(file, "utf8");

    expect(file).toContain("/proposal/");
    expect(body).toContain("status: draft");
    for (const heading of [
      "## Decision",
      "## Evidence",
      "## Approach",
      "## Acceptance Criteria",
      "## Implementation Notes",
    ]) {
      expect(body).toContain(heading);
    }

    expect(blueprint("status", file, "approved").status).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("status: approved");
    expect(blueprint("status", file, "complete").status).toBe(0);
    expect(blueprint("status", file, "plan_" + "review").status).toBe(1);
  });

  test("finds and archives proposals", () => {
    const file = blueprint("create", "proposal", "Archive me").stdout.trim();
    expect(blueprint("find", "--type", "proposal", "--match", "archive-me").stdout.trim()).toBe(file);

    const archived = blueprint("archive", "archive-me");
    expect(archived.status).toBe(0);
    const archivedFile = archived.stdout.split("\n")[0];
    expect(archivedFile).toContain("/archive/");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(archivedFile)).toBe(true);
  });
});

describe("safe creation", () => {
  test("rejects project names that escape the blueprint root", () => {
    expect(command("git", ["init", "-b", "main"], projectDir).status).toBe(0);
    expect(
      command(
        "git",
        ["remote", "add", "origin", "https://example.test/.."],
        projectDir,
      ).status,
    ).toBe(0);

    const result = blueprint("create", "proposal", "Unsafe project");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe blueprint project name");
  });

  test("quotes YAML scalars from create and link without changing their values", () => {
    projectDir = join(root, 'fixture: "#\\path');
    mkdirSync(projectDir);
    const topic = 'Fix "quoted": #hash\\tail\nnext line';
    const branch = 'feature/"quoted": #hash\\tail';
    const source = 'origin "quoted": #hash\\tail';

    const created = blueprint("create", "report", topic, "--branch", branch, "--source", source);
    expect(created.status).toBe(0);
    const file = created.stdout.trim();
    const body = readFileSync(file, "utf8");
    expect(body).toContain(`topic: ${quotedYaml(topic)}\n`);
    expect(body).toContain(`project: ${quotedYaml(projectDir)}\n`);
    expect(body).toContain(`branch: ${quotedYaml(branch)}\n`);
    expect(body).toContain(`source: ${quotedYaml(`[[${source}]]`)}\n`);

    const updatedSource = 'updated "source": #two\\tail';
    expect(blueprint("link", file, updatedSource).status).toBe(0);
    const linked = readFileSync(file, "utf8");
    expect(linked).toContain(`source: ${quotedYaml(`[[${updatedSource}]]`)}\n`);
    expect(linked.match(/^source:/gm)).toHaveLength(1);
  });

  test("rejects topics that generate an empty slug", () => {
    for (const topic of ["the and or", "*"]) {
      const result = blueprint("create", "proposal", topic);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("empty slug");
    }
  });

  test("rejects unsafe status and depth metadata", () => {
    expect(blueprint("create", "report", "Bad status", "--status", "complete\nkind: injected").status).toBe(1);
    expect(blueprint("create", "proposal", "Bad depth", "--depth", "high\nstatus: complete").status).toBe(1);
  });

  test("refuses to overwrite an epoch and slug collision", () => {
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeDate = join(fakeBin, "date");
    writeFileSync(
      fakeDate,
      '#!/bin/sh\ncase "$1" in\n  +%s) echo 1711324800 ;;\n  -u) echo 2024-03-25T00:00:00Z ;;\n  *) exit 1 ;;\nesac\n',
    );
    chmodSync(fakeDate, 0o755);
    const env = { PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}` };

    const first = blueprintWithEnv(env, "create", "proposal", "Collision");
    expect(first.status).toBe(0);
    const original = readFileSync(first.stdout.trim(), "utf8");

    const second = blueprintWithEnv(env, "create", "proposal", "Collision");
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already exists");
    expect(readFileSync(first.stdout.trim(), "utf8")).toBe(original);
  });
});

describe("blueprint root normalization", () => {
  test("resolves create output through a relative root with trailing slashes", () => {
    exerciseConfiguredRoot(`${relative(projectDir, blueprintDir)}///`, "Relative root");
  });

  test("resolves create output through a symlinked root", () => {
    const linkedRoot = join(root, "blueprints-link");
    symlinkSync(blueprintDir, linkedRoot, "dir");
    exerciseConfiguredRoot(`${linkedRoot}/`, "Symlink root");
  });
});

describe("unambiguous resolution", () => {
  test("rejects an ambiguous match and exposes all candidates on request", () => {
    const first = artifactFile("proposal", 1711324800, "shared-cache");
    const second = artifactFile("review", 1711324801, "shared-cache-followup");
    utimesSync(first, new Date(1_000), new Date(1_000));
    utimesSync(second, new Date(2_000), new Date(2_000));

    const ambiguous = blueprint("find", "--match", "shared-cache");
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous blueprint target");
    expect(ambiguous.stderr).toContain(first);
    expect(ambiguous.stderr).toContain(second);

    const all = blueprint("find", "--match", "shared-cache", "--all");
    expect(all.status).toBe(0);
    expect(all.stdout.trim().split("\n")).toEqual([second, first]);

    const exact = blueprint("find", "--exact", basename(first, ".md"));
    expect(exact.status).toBe(0);
    expect(exact.stdout.trim()).toBe(first);
  });

  test("archives only an exact target and rejects partial ambiguity", () => {
    const first = artifactFile("proposal", 1711324800, "shared-one");
    const second = artifactFile("review", 1711324801, "shared-two");

    const ambiguous = blueprint("archive", "shared");
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous blueprint target");
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);

    const archived = blueprint("archive", basename(first, ".md"));
    expect(archived.status).toBe(0);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(archived.stdout.split("\n")[0])).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test("rejects no-target archive when more than one artifact is active", () => {
    const first = artifactFile("proposal", 1711324800, "first");
    const second = artifactFile("review", 1711324801, "second");

    const result = blueprint("archive");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ambiguous blueprint target");
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test("refuses to archive an invalid artifact", () => {
    const invalid = artifactFile("report", 1711324800, "invalid-artifact");
    writeFileSync(invalid, "not a blueprint\n");

    const result = blueprint("archive", invalid);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing opening frontmatter delimiter");
    expect(existsSync(invalid)).toBe(true);
  });
});

describe("safe commits", () => {
  test("refuses to commit an invalid artifact", () => {
    const invalid = artifactFile("proposal", 1711324800, "invalid-artifact");
    writeFileSync(invalid, "not a blueprint\n");

    const result = blueprint("commit", "proposal", invalid);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing opening frontmatter delimiter");
    expect(git("status", "--short").stdout).toContain("??");
  });

  test("commits only the exact path and leaves unrelated artifacts untracked", () => {
    const target = artifactFile("proposal", 1711324800, "target");
    const unrelated = artifactFile("proposal", 1711324801, "unrelated");

    const result = blueprint("commit", "proposal", target);
    expect(result.status).toBe(0);
    expect(git("ls-files").stdout.trim()).toBe(`${basename(projectDir)}/proposal/${basename(target)}`);
    expect(git("status", "--short").stdout).toContain(`?? ${basename(projectDir)}/proposal/${basename(unrelated)}`);
  });

  test("treats project pathspec metacharacters literally", () => {
    projectDir = join(root, "*");
    mkdirSync(projectDir);
    const target = blueprint("create", "proposal", "Literal project").stdout.trim();
    const unrelatedDir = join(blueprintDir, "victim", "proposal");
    mkdirSync(unrelatedDir, { recursive: true });
    const unrelated = join(unrelatedDir, basename(target));
    writeFileSync(unrelated, readFileSync(target));

    expect(blueprint("commit", "proposal", target).status).toBe(0);
    expect(git("ls-files").stdout.trim()).toBe(`*/proposal/${basename(target)}`);
    expect(git("status", "--short", "--untracked-files=all").stdout).toContain(
      `?? victim/proposal/${basename(target)}`,
    );
  });

  test("refuses a pre-existing index without disturbing it", () => {
    const staged = artifactFile("proposal", 1711324800, "staged");
    const target = artifactFile("proposal", 1711324801, "target");
    expect(git("add", staged).status).toBe(0);
    const before = git("rev-parse", "HEAD").stdout.trim();

    const result = blueprint("commit", "proposal", "target");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("index is not empty");
    expect(git("rev-parse", "HEAD").stdout.trim()).toBe(before);
    expect(git("diff", "--cached", "--name-only").stdout.trim()).toEndWith(basename(staged));
    expect(git("status", "--short").stdout).toContain(`?? ${basename(projectDir)}/proposal/${basename(target)}`);
  });

  test("commits a tracked artifact deletion by exact slug", () => {
    const target = artifactFile("proposal", 1711324800, "remove-me");
    expect(blueprint("commit", "proposal", target).status).toBe(0);
    rmSync(target);

    const removed = blueprint("commit", "proposal", "remove-me");
    expect(removed.status).toBe(0);
    expect(git("status", "--short").stdout.trim()).toBe("");
    expect(git("log", "-1", "--pretty=%s").stdout.trim()).toBe(`proposal(${basename(projectDir)}): remove-me`);
  });

  test("archives a tracked artifact without staging unrelated work", () => {
    const target = artifactFile("proposal", 1711324800, "archive-me");
    expect(blueprint("commit", "proposal", target).status).toBe(0);
    const unrelated = artifactFile("review", 1711324801, "unrelated");

    const archived = blueprint("archive", target);
    expect(archived.status).toBe(0);
    const archivedFile = archived.stdout.split("\n")[0];
    expect(git("ls-files").stdout).toContain(`${basename(projectDir)}/archive/${basename(target)}`);
    expect(git("ls-files").stdout).not.toContain(`${basename(projectDir)}/proposal/${basename(target)}`);
    expect(git("status", "--short", "--untracked-files=all").stdout).toContain(
      `?? ${basename(projectDir)}/review/${basename(unrelated)}`,
    );
    expect(existsSync(archivedFile)).toBe(true);
  });
});

describe("report kinds", () => {
  test("creates kind metadata and filters reports by kind", () => {
    const context = blueprint("create", "report", "Context map", "--status", "complete", "--kind", "context");
    expect(context.status).toBe(0);
    const diagnosis = artifactFile("report", 1711324800, "diagnosis", "diagnosis");
    const investigation = artifactFile("report", 1711324801, "investigation", "'investigation'");
    expect(readFileSync(context.stdout.trim(), "utf8")).toContain("kind: context");

    expect(blueprint("find", "--type", "report", "--kind", "context").stdout.trim()).toBe(context.stdout.trim());
    expect(blueprint("find", "--type", "report", "--kind", "diagnosis").stdout.trim()).toBe(diagnosis);
    expect(blueprint("find", "--type", "report", "--kind", "investigation").stdout.trim()).toBe(investigation);
  });

  test("rejects malformed kinds and kinds on non-report artifacts", () => {
    expect(blueprint("create", "report", "Bad", "--kind", "Bad Kind").status).toBe(1);
    expect(blueprint("create", "review", "Review", "--kind", "review").status).toBe(1);
  });

  test("validates typed reports while accepting untyped legacy reports", () => {
    const legacy = artifactFile("report", 1711324800, "legacy");
    const typed = artifactFile("report", 1711324801, "typed", '"context"');
    const invalid = artifactFile("report", 1711324802, "invalid", "Bad Kind");

    expect(blueprint("validate", legacy).stdout.trim()).toBe("ok");
    expect(blueprint("validate", typed).stdout.trim()).toBe("ok");
    const invalidResult = blueprint("validate", invalid);
    expect(invalidResult.status).toBe(1);
    expect(invalidResult.stdout).toContain("invalid report kind");
  });
});

test("rejects new spec and plan creation with migration guidance", () => {
  for (const type of ["spec", "plan"]) {
    const result = blueprint("create", type, "Legacy workflow");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("blueprint create proposal");
    expect(result.stderr).toContain("remain discoverable");
  }
});

test("discovers legacy specs and plans without modifying them", () => {
  const spec = legacyFile("spec", 1711324800, "legacy-spec");
  const plan = legacyFile("plan", 1711324801, "legacy-plan");
  utimesSync(spec, new Date(1_000), new Date(1_000));
  utimesSync(plan, new Date(2_000), new Date(2_000));

  expect(blueprint("find", "--type", "spec", "--match", "legacy-spec").stdout.trim()).toBe(spec);
  expect(blueprint("find", "--type", "plan", "--match", "legacy-plan").stdout.trim()).toBe(plan);
  expect(blueprint("find").stdout.trim()).toBe(plan);
});
