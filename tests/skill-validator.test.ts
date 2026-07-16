import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateSkillFile, validateSkills } from "../bin/validate-skills";

const root = resolve(import.meta.dir, "..");

test("repository skills satisfy the shared schema", () => {
  expect(validateSkills(root)).toEqual([]);
});

describe("skill schema failures", () => {
  test("allows omitted tools for explicit capability-driven orchestration", () => {
    const fixture = mkdtempSync(join(tmpdir(), "skill-validator-"));
    const directory = join(fixture, "skills", "example");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    writeFileSync(
      file,
      [
        "---",
        "name: example",
        "description: A sufficiently specific capability-driven skill.",
        "disable-model-invocation: true",
        "user-invocable: true",
        "metadata:",
        "  requires-fresh-workers: true",
        "---",
        "",
        "Use the active harness capability without naming its native tool.",
      ].join("\n"),
    );

    expect(validateSkillFile(file, fixture)).toEqual([]);
    rmSync(fixture, { recursive: true, force: true });
  });

  test("rejects omitted tools for model-routed skills", () => {
    const fixture = mkdtempSync(join(tmpdir(), "skill-validator-"));
    const directory = join(fixture, "skills", "example");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    writeFileSync(
      file,
      [
        "---",
        "name: example",
        "description: A sufficiently specific model-routed skill.",
        "---",
        "",
        "Use an unrestricted native capability.",
      ].join("\n"),
    );

    const issues = validateSkillFile(file, fixture).map((issue) => issue.message);
    expect(issues).toContain("allowed-tools may be omitted only for explicit fresh-worker orchestration");
    rmSync(fixture, { recursive: true, force: true });
  });

  test("rejects omitted tools for explicit skills without a worker marker", () => {
    const fixture = mkdtempSync(join(tmpdir(), "skill-validator-"));
    const directory = join(fixture, "skills", "example");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    writeFileSync(
      file,
      [
        "---",
        "name: example",
        "description: A sufficiently specific explicit fixture skill.",
        "disable-model-invocation: true",
        "user-invocable: true",
        "---",
        "",
        "Run only when the user invokes this skill.",
      ].join("\n"),
    );

    const issues = validateSkillFile(file, fixture).map((issue) => issue.message);
    expect(issues).toContain("allowed-tools may be omitted only for explicit fresh-worker orchestration");
    rmSync(fixture, { recursive: true, force: true });
  });

  test("reports mismatched names and missing references", () => {
    const fixture = mkdtempSync(join(tmpdir(), "skill-validator-"));
    const directory = join(fixture, "skills", "example");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "SKILL.md");
    writeFileSync(
      file,
      [
        "---",
        "name: wrong",
        "description: A sufficiently specific fixture skill description.",
        "allowed-tools: Bash, NativeTask",
        "argument-hint:",
        "  - not-a-string",
        "metadata: also-not-a-mapping",
        "---",
        "",
        "@rules/missing.md applies.",
        "Use $missing-skill or /skill:also-missing.",
      ].join("\n"),
    );

    const issues = validateSkillFile(file, fixture).map((issue) => issue.message);
    expect(issues).toContain("name must match directory: example");
    expect(issues).toContain("non-portable allowed tool: NativeTask");
    expect(issues).toContain("argument-hint must be a string");
    expect(issues).toContain("metadata must be a mapping");
    expect(issues).toContain("missing rule reference: @rules/missing.md");
    expect(issues).toContain("missing skill invocation: $missing-skill");
    expect(issues).toContain("missing skill invocation: /skill:also-missing");
    rmSync(fixture, { recursive: true, force: true });
  });
});
