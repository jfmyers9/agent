---
name: multi-model-review
description: >
  Run three independent durable code reviews with Claude Opus 5, GPT-5.6 Sol,
  and GPT-5.6 Terra, then compare their decisions. Invoke only when the user
  explicitly requests a multi-model review; use review for one reviewer or
  verification of an existing review.
disable-model-invocation: true
user-invocable: true
metadata:
  requires-fresh-workers: true
argument-hint: >
  [--local|<branch>|<PR>] [--path <glob>] [--proposal <slug-or-path>]
---

# Multi-Model Review

Run the same initial `$review` independently with three fixed models and report
their decisions without merging or rewriting their findings.

@rules/harness-compat.md applies.

## Arguments

Forward the initial-review arguments accepted by `$review`:

- `--local` — review staged, unstaged, and relevant untracked changes.
- `<branch>|<PR>` — review a branch diff or pull request.
- `--path <glob>` — restrict each review to matching changed files.
- `--proposal <slug-or-path>` — give each reviewer the same intent source.

Use `$review` target resolution when no target is supplied. Reject unknown
flags and `--verify`; verify each resulting artifact separately with
`$review --verify <review>`.

## Workflow

1. Read repository instructions and resolve the target and optional proposal
   once. Capture the target commit IDs, changed paths, local diff fingerprints,
   and proposal fingerprint needed to keep all three reviews comparable.
2. Require a waitable, one-shot fresh-worker capability with explicit model
   selection. Stop before launching any worker when the active harness cannot
   provide it. In Pi, launch each worker from the target repository with:

   ```sh
   pi --print --no-session --model <model> "<complete stage packet>"
   ```
3. Launch exactly one fresh worker for each model:

   - `anthropic/claude-opus-5`
   - `openai/gpt-5.6-sol`
   - `openai/gpt-5.6-terra`

   Start every worker with zero inherited conversation turns. Do not reuse,
   resume, or send follow-up work to a reviewer. Require each reviewer to act
   alone without delegating.
4. Send each worker only the repository path, normalized review arguments,
   resolved target snapshot, proposal path and fingerprint when present, and
   this instruction:

   ```text
   Invoke the installed $review skill with the supplied arguments. Complete
   its full initial-review workflow, including artifact validation and commit.
   Review only the supplied snapshot. Return the result schema below.
   ```

   Require:

   ```text
   Model: <model>
   Verdict: GO | NO-GO
   Recommendation: proceed | fix | replace
   Approach: sound | salvageable | misguided
   Artifact: <absolute review path>
   Unresolved findings: <IDs or none>
   Checks: <commands and results>
   Outcome: reviewed | blocked | failed
   ```

5. Wait for each terminal result before launching the next reviewer. `$review`
   commits artifacts in a shared blueprint repository, so concurrent reviewers
   can contend for its Git index. Continue after an individual model failure,
   but do not substitute another model or retry automatically.
6. Before every launch and after every result, verify that the reviewed target,
   worktree diff, index, and proposal fingerprint still match the captured
   snapshot. Stop remaining launches on drift; preserve completed artifacts
   and report that their bases are no longer comparable.
7. Return one row per model with its outcome, decision, approach, artifact,
   unresolved IDs, and checks. Call out disagreements directly. Do not invent a
   fourth consensus verdict, edit source, combine findings, verify reviews, or
   change remote state.
