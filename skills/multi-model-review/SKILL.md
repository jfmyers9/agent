---
name: multi-model-review
description: >
  Launch parallel high-effort Pi lanes for independent transient code reviews
  with Claude Opus 5 and GPT-5.6 Sol, then adjudicate them in a fresh GPT-5.6
  Sol judge lane and store one aggregate review blueprint. Invoke only when the
  user explicitly requests a multi-model review.
disable-model-invocation: true
user-invocable: true
metadata:
  requires-fresh-workers: true
argument-hint: >
  [--local|<branch>|<PR>] [--path <glob>] [--proposal <slug-or-path>]
---

# Multi-Model Review

Run the same initial `$review --transient` in two parallel Pi lanes, have a
fresh Sol judge lane produce the final decision, and store one aggregate review.

@rules/blueprints.md and @rules/artifact-readability.md apply.

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
   and proposal fingerprint needed to keep both reviews comparable.
2. Require Pi's `spawn_lane` capability with explicit model selection and a
   visible split-pane or new-window placement. Stop before launching when it is
   unavailable.
3. Prepare exactly one direct, root, non-interactive Pi lane for each fixed
   model and thinking pair:

   - `anthropic/claude-opus-5` with `thinking: high`
   - `openai/gpt-5.6-sol` with `thinking: high`

   Give every lane the target repository as `cwd`, its fixed `model` and
   `thinking`, and a distinct name. Start both lanes before waiting for or
   reading either result. Do not use CLI-launched worker sessions.
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

5. After both launches succeed or fail, monitor their recorded session
   paths until every lane exits or reaches a terminal result. Read each lane's
   final assistant response from its session log. Continue after an individual
   model failure, but do not substitute another model or retry automatically.
6. After collecting results, verify that the reviewed target, worktree diff,
   index, and proposal fingerprint still match the captured snapshot. On
   drift, do not launch the judge; retain the reviews and report them as
   incomparable.
7. Launch one new direct, root, non-interactive judge lane with
   `model: openai/gpt-5.6-sol` and `thinking: high`. Give it the captured
   snapshot and both complete reviewer responses, but no parent conversation
   context. Require it to inspect current source and checks needed to
   revalidate disputed candidates, apply the installed `$review` decision and
   materiality contract without starting another discovery pass, group
   duplicate root causes, and reject claims lacking concrete evidence. It must
   not delegate, edit source, or write an artifact. Require a complete aggregate
   review body using the installed `$review` Markdown structure, with new stable
   finding IDs, source-review provenance in each accepted finding, an empty
   resolution table when findings exist, and only judge-accepted findings.

   Require:

   ```text
   Judge: openai/gpt-5.6-sol (high)
   Verdict: GO | NO-GO
   Recommendation: proceed | fix | replace
   Approach: sound | salvageable | misguided
   Accepted findings: <source review and finding, evidence, required outcome>
   Rejected candidates: <source review and finding, reason>
   Checks: <commands and results>
   Aggregate review: <complete review Markdown>
   Outcome: judged | blocked | failed
   ```

8. Wait for the judge lane's terminal result and read its final assistant
   response from the recorded session log. Do not retry with another model or
   adjudicate in the main session if the judge blocks or fails.
9. Recheck the captured snapshot. Stop without creating an artifact on drift or
   when the judge omitted required review sections or included unaccepted
   findings. Do not repair or reinterpret the judge's review in the main
   session.
10. Create one aggregate review blueprint:

    ```sh
    file=$(
      blueprint create review "Aggregate review: <target>" \
        --status complete --branch "$branch"
    )
    ```

    Omit `--branch` when none applies. Preserve generated frontmatter and write
    the judge's complete aggregate review body below it. If the explicit
    proposal is a blueprint, derive its full filename stem and link it:

    ```sh
    source_slug=$(basename "$source_file" .md)
    blueprint link "$file" "$source_slug"
    ```

    Run `blueprint validate "$file"`, then `blueprint commit review "$file"`.
    Stop on any error; this exact blueprint commit is the only intended write.
11. Return the aggregate artifact path and judge decision first, followed by
    one row per reviewer with its outcome, decision, approach, unresolved IDs,
    checks, and lane session path. Report the judge lane path and rejected
    candidates. Do not edit reviewed source or change target-repository or
    remote state.
