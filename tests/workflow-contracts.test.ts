import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

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
  test("artifact storage is isolated from task skills", () => {
    const artifact = read("skills/artifact/SKILL.md");
    expect(artifact).toContain("disable-model-invocation: true");
    expect(artifact).toContain("user-invocable: true");
    expect(artifact).toContain("@rules/blueprints.md");
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
      for (const match of body.matchAll(/\/skill:([a-z][a-z0-9-]*)/g)) {
        expect(skillNames).toContain(match[1]);
      }
    }
  });

  test("Graphite operations retain explicit scope and draft defaults", () => {
    const graphite = read("skills/gt/SKILL.md");
    expect(graphite).toContain("second explicit user confirmation");
    expect(graphite).toContain("`--force`/`-f`");
    expect(graphite).toContain("`--delete-all`/`-d`");
    const submit = read("skills/submit/SKILL.md");
    expect(submit).toContain("--dry-run");
    expect(submit).toContain("--restack-only");
    expect(submit).toContain("--no-stack");
    expect(submit).toContain("--draft");
    expect(submit).not.toContain("--sync-only");
  });
});
