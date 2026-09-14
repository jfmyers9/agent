---
name: review
description: >
  Review code changes for material introduced defects and whether the approach
  achieves the intended outcome. Return evidence-backed findings in chat.
  Invoke only as /skill:review or $review; use respond for active PR feedback.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "[--local|<branch>|<PR>] [--path <glob>]"
---

# Review

Assess the approach and report actionable defects with concrete evidence.

@rules/harness-compat.md applies.

## Scope

- `--local`: staged, unstaged, and relevant untracked changes against `HEAD`.
- `<branch>`: merge-base diff against its PR base or Graphite parent, falling
  back to trunk. Resolve the actual parent rather than reviewing an entire
  stack against trunk.
- `<PR>`: resolve the pull request's base and head without checking it out.
- No target: current branch; use local changes when on trunk. Identify dirty
  worktree changes separately from a committed branch or PR review.
- `--path <glob>`: restrict the resolved change set to matching changed files.
  Label the review partial; do not claim the whole changeset is ready to merge.

Record the target, base and head SHAs, and meaningful scope exclusions. For a
local review, record `HEAD` and describe the working-tree scope. If the code
changes during review, recheck affected conclusions or report the limitation.
Inspect untracked filenames before opening relevant source or tests; avoid
likely secrets, build output, and unrelated files. Inspect generated files and
lockfile changes when they affect the behavior under review.

Use supplied plans, reviews, and other documents as context. Revalidate claims
against current code; an artifact's status never gates review or authorizes
additional actions. Do not discover unrelated artifacts automatically.

## Assess The Approach

Read repository instructions, the diff, and the stated objective before
line-level analysis. Mark inferred intent explicitly. Ask only when ambiguity
prevents a meaningful conclusion; continue reviewing independent behavior.

Check that the problem exists, the mechanism achieves the objective, and the
change preserves relevant acceptance criteria, contracts, and non-goals.
Consider responsibility placement, ownership, scope, and complexity when they
affect the result. Evaluate new public options, defaults, and authorization
boundaries against the requested experience; do not invent product controls as
fixes without a demonstrated need.

Recommend replacing the central approach only when local corrections cannot
make it acceptable. Explain the decisive evidence and a feasible alternative.
In that case, prioritize the structural problem and independent critical risks
instead of cataloguing repairs to code that should be replaced.

## Investigate Candidates

Trace changed behavior through callers, consumers, state transitions, error
paths, and asynchronous boundaries. Apply checks where the change creates a
relevant risk:

- Correctness: observable behavior, defaults, contracts, ownership, and lifetime.
- Design: changed responsibilities, dependencies, abstractions, or public
  surface with a concrete failure or maintenance cost.
- Security: changed trust boundaries, authorization, validation, disclosure,
  injection, or secret handling with a reachable exploit path.
- Operations: affected persistence, races, atomicity, retries, partial failure,
  resource bounds, or rollout compatibility.
- Tests: a named regression that coverage misses, false confidence from an
  assertion or mock, or realistic flakiness. Check existing coverage before
  claiming a gap; suggest a concrete setup, action, and assertion.

Keep a finding only when the change introduced or newly activated a material
problem, a reachable trigger has concrete impact, and source or execution
evidence establishes it. Verify assumptions against relevant code and run
focused checks when they help distinguish a defect from a plausible concern.
Do not run destructive tests or modify reviewed source to prove a finding.

Deduplicate by root cause. Fold missing regression coverage into the underlying
functional finding. Omit style preferences, optional cleanup, generic hardening,
and speculative future work. Do not search unchanged code for latent defects;
mention an encountered pre-existing issue separately only when useful, without
attributing it to this change.

For follow-up reviews, inspect the fixes and affected behavior against current
code. Revalidate supplied findings and report remaining or newly introduced
problems. No persisted finding IDs or closure ledger are required.

## Report

Lead with the assessment: whether the change is ready within the reviewed
scope, needs corrections, or requires a different approach. For each finding,
ordered by impact, provide:

- A short title and severity: critical, high, or medium.
- A precise file and line reference, or the relevant cross-file locations.
- The trigger, resulting impact, and evidence establishing the defect.
- The required observable correction; prescribe an implementation only when
  the evidence requires it.

Explain any approach concern, then summarize checks actually performed and
material limitations. If no actionable findings remain, say so directly;
passing review does not establish correctness outside the inspected scope.

Return the review in chat. Do not edit source, change branches, post comments,
commit, or write artifacts as part of review. If the user explicitly requests
saved output, use the artifact skill to save the completed review separately.
