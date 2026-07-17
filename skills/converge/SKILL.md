---
name: converge
description: >
  Drive an explicitly requested code change through implementation and a
  bounded review/fix/verify loop, using a brand-new isolated worker for every
  stage until a full-scope GO or terminal stop. Use for convergence without
  committing or submitting; use vibe for branch-to-PR delivery.
disable-model-invocation: true
user-invocable: true
metadata:
  requires-fresh-workers: true
argument-hint: "<change-or-artifact> [--current] [--max-rounds <1-5>]"
---

# Converge

Produce a verified changeset through isolated implementation, review, fix,
verification, and validation workers without creating a tracker or changing
the branch, index, commit history, or remotes.

@rules/context-budget.md and @rules/harness-compat.md apply.

## Arguments

- `<change-or-artifact>` — objective, acceptance criteria, or one explicitly
  named proposal/report/legacy artifact. It is required unless `--current`
  makes the objective unambiguous.
- `--current` — skip implementation and converge the current worktree changes.
- `--max-rounds <1-5>` — maximum fix rounds; default `3`.

Reject unknown flags, out-of-range limits, and missing or incompatible input.
Invocation authorizes bounded source and test edits within the objective. It
does not authorize branch creation, staging, commits, pushes, submission, or
blueprint writes. Treat a named artifact as read-only input.

## Fresh-Context And State Contract

The coordinator is the only long-lived context. It may perform preflight,
maintain the compact ledger, inspect worker results, and enforce repository
state. It must delegate every substantive stage to a brand-new worker:

1. implementation, unless `--current`;
2. every full discovery review;
3. every fix attempt;
4. every closure verification; and
5. final validation.

For every stage:

- Start a worker with zero inherited conversation turns. Never reuse a worker,
  resume its context, or send it a follow-up stage.
- Require the worker to act alone. It must not delegate, fork, or spawn another
  agent; only the coordinator creates workers.
- Send only the stage packet defined below. Do not forward transcripts, raw
  tool output, or discarded reasoning.
- Require the worker to read repository instructions, inspect the live
  worktree, and load the installed contract named for its role.
- Use a one-shot, waitable, ephemeral worker mechanism. Wait for its terminal
  structured result before launching another worker. Never run mutating
  workers concurrently.
- Forbid every command or tool action that writes Git metadata, refs, the
  index, repository config, or remotes. This includes staging, restoring,
  stashing, committing, branch operations, `update-ref`, config writes,
  fetch/pull, push, and submission commands.

Use the active harness capability generically; do not name or persist native
task, team, lane, or session state. If the harness cannot provide a new
isolated context and one terminal result per launch, stop before the first
stage. Do not silently run the stage in the coordinator context.

Maintain only this compact coordinator ledger:

- objective, observable acceptance criteria, and allowed scope;
- baseline branch, `HEAD`, current branch ref, basis-dependent refs, repository
  config, index, changed-path, and content fingerprints;
- current intended snapshot and unrelated paths to preserve;
- fix round and maximum;
- current full-review basis generation, verdict, and approach rating;
- stable `F` IDs with resolution and verification state;
- mapped fix deltas and focused/final check results; and
- terminal blocker or replacement recommendation.

Before and after every worker, independently compare the branch, `HEAD`,
current branch ref, refs on which the review basis or checks depend, repository
config, index, changed paths, and tracked/relevant-untracked content
fingerprints. Also observe other local refs so concurrent activity in a linked
worktree can be classified without being attributed to the worker. A read-only
worker must leave relevant repository state unchanged. An implementation or
fix worker may change only its authorized worktree paths.

Stop on an unexpected change to the branch, `HEAD`, current branch ref,
repository config, index, or worktree content. If only a basis-dependent ref
moved, invalidate the affected basis and route to a fresh full review. If only
unrelated refs moved, record their new values and continue. Never undo another
actor's changes or treat unrelated shared-ref movement as worker failure.

Require every worker result to attest `Git / remote actions: none`. A missing
or different attestation is terminal even when local snapshots match. Apply
harness restrictions that deny network and Git-metadata writes when available;
the behavioral prohibition still applies when the harness lacks such controls.

Every stage packet includes the repository path, stage role, objective and
criteria, only the ledger fields needed by that stage, its mutation boundary,
the no-delegation and Git/remote prohibitions, and its exact output schema.
Workers inspect live files instead of receiving copied source or full diffs.

## Workflow

### 1. Preflight And Bound The Change

Read repository instructions and inspect `git status --short`. Confirm a
waitable fresh-worker mechanism before any mutation.

- New change: require a clean baseline. Do not stash, absorb, or discard
  existing work.
- `--current`: fingerprint the current tracked diff and relevant untracked
  files as the intended changeset. Stop when unrelated ownership or scope is
  ambiguous. Use the supplied objective, or infer it only when the diff is
  unambiguous. Never read likely secret files implicitly.

Resolve an explicitly named artifact exactly as `implement` resolves an input,
but do not update, validate, stage, or commit it. Derive concrete acceptance
criteria, allowed scope, and preserved paths. Record the baseline snapshot,
including the current branch ref, refs on which the review basis or checks
depend, observed unrelated refs, and repository Git config. Resolve named refs
to commit IDs in stage packets so workers do not silently adopt later movement.

### 2. Implement In A Brand-New Worker

Skip this stage with `--current`. Otherwise launch a fresh implementation
worker with the objective, criteria, scope, baseline, and mutation boundary.
Tell it to follow the installed `implement` workflow for source changes while
skipping all artifact-update and Git side effects. It must make the smallest
complete change, preserve unrelated paths, and run focused checks.

Require:

```text
Outcome: implemented | scope-expansion-required | blocked
Acceptance: <criterion and status>
Changes: <every path and hunk>
Checks: <command and result>
Risks: <remaining risk or none>
State: <branch, HEAD, index, and changed paths>
```

Accept `implemented` only after the coordinator's state comparison passes and
all changes fit the allowed scope. Otherwise stop; do not repair the worker's
work in the coordinator context.

### 3. Establish A Basis In A Brand-New Full Reviewer

Launch a fresh read-only full reviewer after implementation, and whenever a
later stage returns `fresh-review-required`. Give it the objective, criteria,
baseline, current intended snapshot, complete paths, and any compact trigger
evidence. For a refreshed basis, include stable finding rows but no prior
review prose. Never include implementation or fixer narratives.

Tell it to follow the installed `review` decision, lens, materiality,
root-cause grouping, and basis contracts without creating a review blueprint.
It must review the complete current changeset, assign new IDs after the highest
existing ID, preserve still-applicable IDs, and create a new immutable basis
generation. Deferred observations never enter this loop.

Require:

```text
Outcome: reviewed | blocked | state-mutated
Verdict: GO | NO-GO
Recommendation: proceed | fix | replace
Approach: sound | salvageable | misguided
Review basis: <generation and full paths/contracts/boundaries/fingerprints>
Findings: <stable F IDs with severity, evidence, impact, required change>
Checks: <commands and results>
State: <branch, HEAD, index, and changed paths>
```

On `NO-GO / replace`, stop and return the decisive evidence and feasible
replacement shape; never patch around a misguided approach. On `NO-GO / fix`,
enter the fix loop. On full-scope `GO / proceed` with a `sound` approach and no
unresolved findings, continue to final validation.

### 4. Fix In A Brand-New Worker

Increment the round and stop before editing if it exceeds the configured
maximum. Launch a fresh fixer with only the objective, criteria, allowed paths,
current immutable review basis, unresolved `F` rows, verified rows that must
remain closed, and pre-worker snapshot.

Tell it to follow the installed `fix` revalidation and scope rules without
reading or writing a blueprint. Before editing, it must return
`fresh-review-required` if basis drift or the necessary correction exceeds the
recorded basis. Otherwise it may edit only valid unresolved findings and must
map every changed path and hunk to an ID.

Require:

```text
Outcome: fixed | no-change | fresh-review-required | blocked
Resolutions: <per-ID classification, evidence, and pending status>
Changes: <ID to every changed path and hunk>
Checks: <command and result>
State: <branch, HEAD, index, and changed paths>
```

Stop on unmapped edits, ambiguous partial work, or repository-state mismatch.
Route a clean, pre-edit `fresh-review-required` result to step 3. Otherwise
continue to verification even when the fixer reports `no-change`.

### 5. Verify In A Brand-New Reviewer

Launch a different fresh, read-only reviewer with the current immutable basis,
complete finding ledger, fixer resolution rows, mapped fix delta, round, and
exact pre-worker snapshot. Include finding evidence, not prior review prose.

Tell it to apply only the installed `review` closure contract:

- verify pending resolutions and every mapped fix hunk;
- preserve verified findings unless an overlapping edit regressed them;
- never rerun broad discovery or add deferred observations;
- append a new `F` only for a blocker introduced by the mapped fix; and
- return `fresh-review-required` for an original-scope miss, unmapped drift,
  expanded behavior, or replacement of the central approach.

Require:

```text
Outcome: verified | fix-required | fresh-review-required | blocked | state-mutated
Verdict: GO | NO-GO
Recommendation: proceed | fix
Approach: sound | salvageable
Findings: <all IDs with resolution and verification state>
Fix delta: <ID-to-hunk mapping>
Basis drift: none | <reason a fresh full review is required>
Checks: <commands and results>
State: <branch, HEAD, index, and changed paths>
```

Merge the result only after the read-only state comparison passes. Route
`fix-required` to step 4 and `fresh-review-required` to step 3, where a new
full-scope basis replaces the stale generation. Continue only on full-scope
`GO / proceed` with a `sound` approach and zero unresolved `F` findings.

### 6. Validate In A Brand-New Final Worker

Launch a fresh, read-only validation worker with the objective, criteria,
current full-review basis, complete finding ledger, check history, and exact
pre-worker branch, `HEAD`, index, path, and content fingerprints. It must
inspect the complete final diff for unrelated changes and run required checks
only in non-mutating forms. It must compare repository state before and after
those checks; the coordinator repeats that comparison independently.

Require:

```text
Outcome: pass | fix-introduced | fresh-review-required |
  baseline-or-environmental | state-mutated | blocked
Checks: <command, result, and failure classification>
Finding: <new F with fix-delta causality, or none>
Review trigger: <original-scope/unmapped evidence, or none>
Snapshots: <before and after branch/HEAD/index/path/content fingerprints>
```

- `fix-introduced`: only when evidence traces the failure to the latest mapped
  fix. Append its `F` to the current basis and return to step 4 if rounds remain.
- `fresh-review-required`: use for an original-scope miss or newly exposed
  scope. Return to step 3; do not append it to the frozen basis.
- `baseline-or-environmental`: report the evidenced external or pre-existing
  failure without editing.
- `state-mutated`: stop without accepting `GO` or undoing the mutation.

Final validation is not another broad review. `pass` completes only when the
relevant read-only snapshots match and every required check succeeds.

## Stop Conditions And Output

Stop when the recommendation is `replace`, the same finding fails two
consecutive fixes, unresolved findings do not decrease across two rounds, a
fresh-review transition produces no actionable new basis, a worker leaves
ambiguous partial edits, or the round limit is reached. Preserve the worktree
and report the exact evidence or user decision needed.

Success requires a current full-scope `GO / proceed`, a `sound` approach, zero
unresolved `F` findings, passing final checks, matching relevant read-only
snapshots and Git metadata, a no-remote-action attestation from every worker,
and no unrelated worktree changes. Unrelated shared-ref movement does not
prevent success.

Report the final verdict, files changed, fix-round count, basis-generation
count, resolved IDs, and checks. Suggest `$commit` when useful. Never stage,
commit, push, submit, or create or update a blueprint.
