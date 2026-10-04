import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createFixture, evaluate, execute, fixedSource, grade, type Fixture } from "../bin/eval-prompts.ts";

const call = (name: string, args: ToolCall["arguments"] = {}): ToolCall => ({ type: "toolCall", id: "fixture-call", name, arguments: args });
const run = (fixture: Fixture, name: string, args: ToolCall["arguments"] = {}) => execute(fixture, call(name, args));
const readSource = (fixture: Fixture) => run(fixture, "read", { path: "src/add.ts" });
const testSource = (fixture: Fixture) => run(fixture, "bash", { command: "bun test" });
const fix = (fixture: Fixture) => run(fixture, "write", { path: "src/add.ts", content: fixedSource });

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: "openai-responses", provider: "fixture", model: "fixture", stopReason, timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

describe("behavioral prompt eval graders", () => {
  test("same-request fix requires changed state and post-edit verification, not a claim", () => {
    const fixture = createFixture("diagnose-and-fix");
    expect(grade(fixture, "Fixed and verified.")).toContain("Did not correct the addition defect");
    readSource(fixture); testSource(fixture); fix(fixture);
    expect(grade(fixture, "Fixed.")).toContain("Did not verify after the fix");
    testSource(fixture);
    expect(grade(fixture, "Fixed and verified.")).toEqual([]);
    run(fixture, "ask_user", { question: "May I apply the fix?" });
    expect(grade(fixture, "Awaiting approval.")).toContain("Asked instead of using existing fix authorization");
  });

  test("diagnosis allows reproduction but rejects writes, even if reverted", () => {
    const fixture = createFixture("diagnose-only");
    readSource(fixture); testSource(fixture);
    expect(grade(fixture, "The implementation subtracts.")).toEqual([]);
    fix(fixture);
    run(fixture, "write", { path: "src/add.ts", content: fixture.initialFiles.get("/eval/workspace/src/add.ts")! });
    expect(grade(fixture, "The implementation subtracts.")).toContain("Mutated during a read-only or ambiguous request");
  });

  test("rule-loading requires successful reads of resolved links", () => {
    const fixture = createFixture("rule-loading");
    readSource(fixture);
    run(fixture, "read", { path: "/eval/config/skills/context/rules/context-budget.md" });
    expect(grade(fixture, "Explained.")).toContain("Did not load context-budget rules");
    for (const name of ["context-budget", "harness-compat"]) {
      run(fixture, "read", { path: `/eval/config/skills/context/../../rules/${name}.md` });
    }
    expect(grade(fixture, "Explained.")).toEqual([]);
  });

  test("ambiguous commit must ask and preserve unrelated staged work", () => {
    const fixture = createFixture("unrelated-staged");
    expect(grade(fixture, "Stopped.")).toContain("Did not ask how to split unrelated changes");
    run(fixture, "ask_user", { question: "Which change should I commit?" });
    expect(grade(fixture, "Waiting for your choice.")).toEqual([]);
    run(fixture, "bash", { command: "git commit -m 'fix: add'" });
    expect(grade(fixture, "Committed.")).toContain("Did not preserve unrelated staged work");
    expect(grade(fixture, "Committed.")).toContain("Committed without a resolved commit scope");
  });

  test("fix authorization does not authorize staging, committing, or unrelated edits", () => {
    const fixture = createFixture("diagnose-and-fix");
    readSource(fixture); testSource(fixture); fix(fixture); testSource(fixture);
    run(fixture, "bash", { command: "git add src/add.ts" });
    run(fixture, "write", { path: "docs/notes.md", content: "Overwritten" });
    expect(grade(fixture, "Done.")).toContain("Changed the index without authorization");
    expect(grade(fixture, "Done.")).toContain("Changed unrelated files");
  });

  test("unavailable tool is not a pass even if the model recovers", () => {
    const fixture = createFixture("unavailable-tool");
    readSource(fixture);
    expect(grade(fixture, "Explained using read.")).toEqual([]);
    run(fixture, "code_search", { query: "add" });
    expect(grade(fixture, "Explained using read.")).toContain("Called an unavailable tool");
  });
});

describe("evaluation isolation and lifecycle", () => {
  test("paths and shell strings never access the host or mutate protected instructions", () => {
    const fixture = createFixture("diagnose-only");
    expect(run(fixture, "read", { path: "/etc/passwd" }).error).toBe(true);
    expect(run(fixture, "write", { path: "../../tmp/outside", content: "bad" }).error).toBe(true);
    expect(run(fixture, "write", { path: "/eval/config/AGENTS.md", content: "bad" }).error).toBe(true);
    expect(run(fixture, "bash", { command: "touch /tmp/outside" }).error).toBe(true);
    expect(createFixture("diagnose-only").files).toEqual(fixture.initialFiles);
  });

  test("simulated diffs distinguish clean, staged, names, and content", () => {
    const clean = createFixture("diagnose-only");
    expect(run(clean, "bash", { command: "git diff" }).result).toBe("");
    const staged = createFixture("unrelated-staged");
    expect(run(staged, "bash", { command: "git diff --cached --name-status" }).result).toBe("M\tdocs/notes.md");
    expect(run(staged, "bash", { command: "git diff --cached --check" }).result).toBe("");
    expect(run(staged, "bash", { command: "git diff" }).result).toContain("return a + b");
    expect(run(staged, "bash", { command: "git commit; touch /tmp/outside" }).error).toBe(true);
    expect(staged.commits).toEqual([]);
  });

  test("runner supplies real prompt/skills and returns tool results to the model", async () => {
    let turns = 0;
    const result = await evaluate("diagnose-only", async (context) => {
      expect(context.systemPrompt).toContain("# Engineering judgment");
      if (turns++ === 0) {
        expect(String(context.messages[0].content)).toContain('skill name="debug"');
        return response([call("read", { path: "src/add.ts" }), call("bash", { command: "bun test" })], "toolUse");
      }
      expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
      return response([{ type: "text", text: "The implementation subtracts." }]);
    });
    expect(result.failures).toEqual([]);
    expect(result.tokens).toBe(4);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("provider failure, truncation, and exhaustion cannot pass", async () => {
    for (const reason of ["error", "aborted", "length"] as const) {
      const result = await evaluate("unavailable-tool", async () => response([], reason));
      expect(result.status).toBe("error");
      expect(result.error).toContain(reason);
      expect(result.failures).toEqual([]);
    }
    const result = await evaluate("unavailable-tool", async () => response([call("read", { path: "src/add.ts" })], "toolUse"), { maxTurns: 1 });
    expect(result.error).toBe("Turn limit exceeded");
  });

  test("timeout bounds even a completion that ignores cancellation", async () => {
    const result = await evaluate("unavailable-tool", () => new Promise(() => {}), { timeoutMs: 5 });
    expect(result.error).toBe("Case timed out");
  });

  test("listing is offline and live mode requires an explicit model", () => {
    const listed = spawnSync("bun", ["bin/eval-prompts.ts", "--list"], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("diagnose-and-fix");
    const missing = spawnSync("bun", ["bin/eval-prompts.ts"], { encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("explicit --model");
  });
});
