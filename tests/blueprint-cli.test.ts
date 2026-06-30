import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cli = resolve(import.meta.dir, "../bin/blueprint");

let root: string;
let projectDir: string;
let blueprintDir: string;

function command(program: string, args: string[], cwd: string) {
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
    },
  });
}

function blueprint(...args: string[]) {
  return command(cli, args, projectDir);
}

function legacyFile(type: "spec" | "plan", epoch: number, slug: string) {
  const dir = join(blueprintDir, basename(projectDir), type);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${epoch}-${slug}.md`);
  writeFileSync(
    file,
    `---\ntopic: "Legacy"\nproject: ${projectDir}\ncreated: 2024-01-01T00:00:00Z\nstatus: approved\n---\n`,
  );
  return file;
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
