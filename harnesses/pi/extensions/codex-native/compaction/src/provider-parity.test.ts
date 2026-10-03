import { expect, test } from "bun:test";

test("native replay accepts real Pi serialization but rejects changed history", () => {
	// Other compaction tests mock pi-coding-agent globally. Use a fresh process
	// so both sides of this regression exercise the installed Pi implementation.
	const result = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`
import assert from "node:assert/strict";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite.ts";

const timestamp = "2026-10-03T00:00:00.000Z";
const model = {
 id: "gpt-5.4", api: "openai-codex-responses", provider: "openai-codex",
 reasoning: true, input: ["text", "image"],
};
const window = [{ type: "compaction", encrypted_content: "opaque-test-window" }];
const compaction = {
 type: "compaction", id: "compact", parentId: "kept", timestamp,
 firstKeptEntryId: "kept", summary: "Prior summary", tokensBefore: 200000,
 details: { compactedWindow: window },
};
const cases = [
 [{ type: "text", text: "Signed reply", textSignature: "msg_signed" }],
 [{ type: "text", text: "Unsigned reply" }, { type: "text", text: "Second block" }],
 [{ type: "text", text: "Phased reply", textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }) }],
 [{ type: "toolCall", id: "call_read|fc_read", name: "read", arguments: { path: "README.md" }, namespace: "functions" }],
 [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } }],
];
for (const content of cases) {
 const assistant = {
  role: "assistant", provider: model.provider, api: model.api, model: model.id,
  content, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: 0,
 };
 const kept = { type: "message", id: "kept", parentId: null, timestamp, message: assistant };
 const messages = [
  { role: "compactionSummary", summary: compaction.summary, tokensBefore: compaction.tokensBefore, timestamp: 0 },
  assistant,
 ];
 const input = convertResponsesMessages(model, { messages: convertToLlm(messages) }, new Set(["openai-codex"]), { includeSystemPrompt: false });
 const replay = (input) => rewriteResponsesPayloadWithNativeReplay({
  model, payload: { input, instructions: "System" }, branchEntries: [kept, compaction], compactionEntry: compaction,
 });
 for (const representation of [input, JSON.parse(JSON.stringify(input))]) {
  const result = replay(representation);
  assert.equal(result.ok, true, JSON.stringify({ content, result }));
  assert.deepEqual(result.rewrittenPayload.input, window);
 }
 // These are real differences, not absent optional JSON properties.
 for (const change of [
  (items) => { items[0].content[0].text += " altered"; },
  (items) => { items[1].id = "different-id"; },
  (items) => { items[1].phase = null; },
  (items) => { items[1].unexpected = "value"; },
 ]) {
  const changed = structuredClone(input);
  change(changed);
  const result = replay(changed);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expected-pi-replay-mismatch");
 }
}
`,
		],
		{ cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
});
