---
name: multi-model-review
description: >
  Launch parallel Pi lanes for independent transient code reviews with Claude
  Opus 5, GPT-5.6 Sol, and GPT-5.6 Terra, then compare their decisions. Invoke
  only when the user explicitly requests a multi-model review.
disable-model-invocation: true
user-invocable: true
metadata:
  requires-fresh-workers: true
argument-hint: >
  [--local|<branch>|<PR>] [--path <glob>] [--proposal <slug-or-path>]
---

# Multi-Model Review

Run the same initial `$review --transient` in three parallel Pi lanes and
compare their decisions without writing review artifacts.

## Arguments

Forward the initial-review arguments accepted by `$review`:

- `--local` — review staged, unstaged, and relevant untracked changes.
- `<branch>|<PR>` — review a branch diff or pull request.
- `--path <glob>` — restrict each review to matching changed files.
- `--proposal <slug-or-path>` — give each reviewer the same intent source.

Use `$review` target resolution when no target is supplied. Reject unknown
flags and `--verify`; use `$review` directly for a durable review or
verification.

## Workflow

1. Read repository instructions and resolve the target and optional proposal
   once. Capture the target commit IDs, changed paths, local diff fingerprints,
   and proposal fingerprint needed to keep all three reviews comparable.
2. Require Pi's `spawn_lane` capability with explicit model selection and a
   visible split-pane or new-window placement. Stop before launching when it is
   unavailable.
3. Prepare exactly one direct, root, non-interactive Pi lane for each model:

   - `anthropic/claude-opus-5`
   - `openai/gpt-5.6-sol`
   - `openai/gpt-5.6-terra`

   Give every lane the target repository as `cwd`, its fixed `model`, and a
   distinct name. Start all three lanes before waiting for or reading any
   result. Do not use CLI-launched worker sessions.
4. Send each lane only the repository path, normalized review arguments,
   resolved target snapshot, proposal path and fingerprint when present, and
   this instruction:

   ```text
   Invoke the installed $review skill with --transient and the supplied
   arguments. Complete its full initial-review workflow without creating or
   changing a blueprint. Review only the supplied snapshot. Act alone without
   delegating. End with the result schema below.
   ```

   Require:

   ```text
   Model: <model>
   Verdict: GO | NO-GO
   Recommendation: proceed | fix | replace
   Approach: sound | salvageable | misguided
   Artifact: none (transient)
   Unresolved findings: <IDs or none>
   Checks: <commands and results>
   Outcome: reviewed | blocked | failed
   ```

5. After all three launches succeed or fail, monitor their recorded session
   paths until every lane exits or reaches a terminal result. Read each lane's
   final assistant response from its session log. Continue after an individual
   model failure, but do not substitute another model or retry automatically.
6. After collecting results, verify that the reviewed target, worktree diff,
   index, and proposal fingerprint still match the captured snapshot. If they
   drifted, retain the results but mark them incomparable.
7. Return one row per model with its outcome, decision, approach, unresolved
   IDs, checks, and lane session path. Call out disagreements directly. Do not
   invent a fourth consensus verdict, edit source, persist review artifacts,
   combine findings, or change remote state.
