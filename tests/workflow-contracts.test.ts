import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const skillNames = readdirSync(resolve(root, "skills"))
  .filter((name) => existsSync(resolve(root, "skills", name, "SKILL.md")));

function markdownFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? markdownFiles(path) : path.endsWith(".md") ? [path] : [];
  });
}

describe("skill boundaries", () => {
  test("formal reviews are opt-in without disabling local checks or bounded workflow steps", () => {
    const policy = read("global/AGENTS.md").replace(/\s+/g, " ");
    expect(policy).toContain("Run review skills, multi-agent review panels, and follow-up review rounds only on explicit user request");
    expect(policy).toContain("Natural-language review requests count");
    expect(policy).toContain("Repository instructions requiring mandatory handoff or review do not grant approval");
    expect(policy).toContain("nor do implementation, commit, or handoff requests alone");
    expect(policy).toContain("Approval for a requested review workflow covers its specified agents and bounded follow-up rounds");
    expect(policy).toContain("no separate per-agent permission is needed");
    expect(policy).toContain("Do not add unrequested review workflows or extra rounds");
    expect(policy).toContain("Continue ordinary local self-review and relevant tests without invoking formal review workflows");
  });

  test("generic review approval does not relax the global review skill's command-only boundary", () => {
    const policy = read("global/AGENTS.md").replace(/\s+/g, " ");
    expect(policy).toContain("the global `review` skill remains command-only: `/skill:review` or `$review`");
    expect(read("skills/review/SKILL.md")).toContain("Invoke only as /skill:review or $review.");
  });

  test("workflow skills require explicit invocation; commit permits natural-language requests", () => {
    for (const name of ["artifact", "review", "context", "debug", "research"]) {
      const skill = read(`skills/${name}/SKILL.md`);
      expect(skill).toContain("disable-model-invocation: true");
      expect(skill).toContain("user-invocable: true");
    }
    const commit = read("skills/commit/SKILL.md");
    expect(commit).not.toContain("disable-model-invocation: true");
    expect(commit).toContain("when the user explicitly asks to commit changes");
  });

  test("debug keeps diagnosis read-only but preserves same-request fix authorization", () => {
    const debug = read("skills/debug/SKILL.md");
    expect(debug).toContain("allowed-tools: Bash, Read, Glob, Grep");
    expect(debug).toContain("bug report in chat");
    expect(debug).toContain("Do not apply the fix or add tests");
    expect(debug).toContain("during diagnosis");
    expect(debug).toContain("A diagnosis-only request ends with the report");
    expect(debug).toContain("user also authorizes a fix, including in the same request");
    expect(debug).toContain("without adding an approval gate");
    expect(debug).toContain("use `$artifact` separately");
    expect(debug).not.toMatch(/blueprint\s+(?:create|status|commit|link)\b/);
  });

  test("context explains existing code with read-only tools and separate planning", () => {
    const context = read("skills/context/SKILL.md");
    expect(context).toContain("allowed-tools: Bash, Read, Glob, Grep");
    expect(context).toContain("explain it in chat");
    expect(context).toContain("use `$research`");
    expect(context).toContain("use `$artifact` separately");
    expect(context).not.toMatch(/blueprint\s+(?:create|status|commit|link)\b/);
  });

  test("research plans in chat with read-only tools and separate storage", () => {
    const research = read("skills/research/SKILL.md");
    expect(research).toContain("allowed-tools: Bash, Read, Glob, Grep");
    expect(research).toContain("A planning-only request ends with the plan");
    expect(research).toContain("without adding an approval gate");
    expect(research).toContain("`$artifact` separately");
    expect(research).not.toMatch(/blueprint\s+(?:create|status|commit|link)\b/);
  });

  test("artifact storage is isolated from task skills", () => {
    const artifact = read("skills/artifact/SKILL.md");
    expect(artifact).toContain("disable-model-invocation: true");
    expect(artifact).toContain("user-invocable: true");
    expect(artifact).toContain("[storage rules](../../rules/blueprints.md)");
    for (const name of skillNames.filter((name) => name !== "artifact")) {
      expect(read(`skills/${name}/SKILL.md`)).not.toMatch(/blueprint (?:create|status|commit|link)\b/);
    }
  });

  test("active documentation has no dangling rule or skill invocations", () => {
    const files = ["README.md", "global/AGENTS.md", "harnesses/pi/README.md",
      ...markdownFiles("skills"), ...markdownFiles("rules")];
    for (const file of files) {
      const body = read(file);
      for (const match of body.matchAll(/@rules\/([A-Za-z0-9_.-]+\.md)/g)) {
        expect(existsSync(resolve(root, "rules", match[1]))).toBe(true);
      }
      if (file.startsWith("skills/") || file.startsWith("rules/")) {
        for (const match of body.matchAll(/\[[^\]\n]*\]\((\.[^\s)]+\.md)(?:#[^\s)]*)?\)/g)) {
          expect(existsSync(resolve(root, dirname(file), match[1]))).toBe(true);
        }
      }
      for (const match of body.matchAll(/\/skill:([a-z][a-z0-9-]*)/g)) {
        expect(skillNames).toContain(match[1]);
      }
    }
  });

});
