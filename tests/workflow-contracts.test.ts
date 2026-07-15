import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const artifactSkills = ["context", "research", "review", "diagnose"];

const directSkills = [
  "implement",
  "fix",
  "debug",
  "respond",
  "split-commit",
  "resume-work",
  "commit",
  "gt",
  "refine",
  "submit",
  "improve-rust-tests",
  "vibe",
];

const allSkillFiles = readdirSync(resolve(root, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(resolve(root, "skills", entry.name, "SKILL.md")))
  .map((entry) => `skills/${entry.name}/SKILL.md`);

describe("opt-in routing", () => {
  test("manual artifact skills require explicit invocation metadata", () => {
    for (const skill of artifactSkills) {
      const body = read(`skills/${skill}/SKILL.md`);
      expect(body).toContain("disable-model-invocation: true");
      expect(body).toContain("user-invocable: true");
    }
  });

  test("ordinary direct workflows create no blueprints", () => {
    for (const skill of directSkills) {
      expect(read(`skills/${skill}/SKILL.md`)).not.toMatch(/blueprint create /);
    }
    expect(read("AGENTS.md")).toContain("Ordinary Q&A, coding, debugging, and PR work");
  });

  test("named artifact skills persist the requested artifact", () => {
    expect(read("skills/research/SKILL.md")).toContain("blueprint create proposal");
    expect(read("skills/review/SKILL.md")).toContain("blueprint create review");
    expect(read("skills/context/SKILL.md")).toContain("--kind context");
    expect(read("skills/diagnose/SKILL.md")).toContain("--kind diagnosis");
  });
});

describe("workflow contracts", () => {
  test("research uses one proposal and one approval boundary", () => {
    const body = read("skills/research/SKILL.md");
    expect(body.match(/blueprint create proposal/g)).toHaveLength(1);
    expect(body).toContain("one approval boundary");
    expect(body).toContain("$implement <proposal>");
  });

  test("implement accepts freeform work without artifact side effects", () => {
    const body = read("skills/implement/SKILL.md");
    expect(body).toContain("Freeform request");
    expect(body).toContain("No artifact");
    expect(body).toContain("require no particular status");
    expect(body).not.toContain("skills/report/SKILL.md");
  });

  test("fix updates the source review resolution table", () => {
    const body = read("skills/fix/SKILL.md");
    expect(body).toContain("Do not create a fix plan");
    expect(body).toContain("## Resolutions");
    expect(body).toContain("blueprint commit review");
  });

  test("review defines focused lenses and stable finding IDs", () => {
    const body = read("skills/review/SKILL.md");
    expect(body).toContain("correctness and compatibility");
    expect(body).toContain("design and maintainability");
    expect(body).toContain("stable sequential IDs");
    expect(body).toContain("## Resolutions");
  });

  test("active workflow docs contain no retired approval states", () => {
    const files = [
      "AGENTS.md",
      "README.md",
      "rules/blueprints.md",
      "rules/harness-compat.md",
      "rules/human-approval.md",
      ...allSkillFiles,
    ];
    const content = files.map(read).join("\n");
    for (const retiredTerm of [
      "spec_" + "review",
      "plan_" + "review",
      "mandatory" + " plan",
      "automatic" + " report",
    ]) {
      expect(content).not.toContain(retiredTerm);
    }
  });

  test("consolidated workflows retain explicit side-effect modes", () => {
    const respond = read("skills/respond/SKILL.md");
    expect(respond).toContain("--plan");
    expect(respond).toContain("--fix");
    expect(respond).toContain("--post");
    expect(respond).toContain("three modes are mutually exclusive");
    expect(respond).toMatch(/when\s+intent is\s+unclear, use `--plan`/);

    const graphite = read("skills/gt/SKILL.md");
    expect(graphite).toContain("`create`");
    expect(graphite).not.toContain("jm/");
    expect(graphite).toContain("second explicit user confirmation");
    expect(graphite).toContain("`--force`/`-f`");
    expect(graphite).toContain("`--delete-all`/`-d`");

    const submit = read("skills/submit/SKILL.md");
    expect(submit).toContain("--dry-run");
    expect(submit).toContain("--restack-only");
    expect(submit).toContain("deprecated compatibility alias");
  });

  test("vibe composes the full workflow behind one explicit invocation", () => {
    const body = read("skills/vibe/SKILL.md");
    expect(body).toContain("disable-model-invocation: true");
    expect(body).toContain("user-invocable: true");
    for (const stage of ["$gt create", "$implement", "$fix", "$commit", "$submit"]) {
      expect(body).toContain(stage);
    }
    expect(body).toContain("--dry-run");
    expect(body).toContain("Review the complete diff in session");
    expect(body).toContain("Submission defaults to a draft pull request");
  });

  test("retired wrappers are absent", () => {
    for (const skill of ["archive", "pr-plan", "report", "simplify", "start"]) {
      expect(existsSync(resolve(root, "skills", skill, "SKILL.md"))).toBe(false);
    }
  });
});
