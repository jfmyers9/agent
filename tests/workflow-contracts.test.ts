import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const artifactSkills = [
  "context",
  "research",
  "review",
  "diagnose",
  "simplify",
  "report",
  "archive",
];

const directSkills = [
  "implement",
  "fix",
  "debug",
  "pr-plan",
  "respond",
  "split-commit",
  "vibe",
  "resume-work",
];

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
    for (const skill of ["context", "diagnose", "simplify", "report"]) {
      expect(read(`skills/${skill}/SKILL.md`)).toContain("blueprint create report");
    }
    expect(read("skills/archive/SKILL.md")).toContain("blueprint archive");
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
      ...artifactSkills.map((skill) => `skills/${skill}/SKILL.md`),
      ...directSkills.map((skill) => `skills/${skill}/SKILL.md`),
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
});
