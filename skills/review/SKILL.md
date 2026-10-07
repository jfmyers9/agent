---
name: review
description: >
  Perform a formal, multi-perspective code review of introduced defects and
  whether the approach achieves the intended outcome. Return a decision and
  evidence-backed findings in chat.
  Invoke only as /skill:review or $review.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "[--local|<branch>|<PR>] [--path <glob>] [--team]"
---

# Review

Assess the approach and report actionable defects with concrete evidence.

Read and follow [harness compatibility](../../rules/harness-compat.md).

## Scope

- `--local`: staged, unstaged, and relevant untracked changes against `HEAD`.
- `<branch>`: merge-base diff against its PR base or parent branch in its
  native GitHub stack, falling back to trunk. Resolve the actual parent rather
  than reviewing an entire stack against trunk.
- `<PR>`: resolve the pull request's base and head without checking it out.
- No target: current branch; use local changes when on trunk. Identify dirty
  worktree changes separately from a committed branch or PR review.
- `--path <glob>`: restrict the resolved change set to matching changed files.
  Label the review partial; do not claim the whole changeset is ready to merge.
- `--team`: explicitly request independent persona subagents; this is also the
  default when delegation is available.

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
Use relevant PR descriptions and commits as claims to verify, not proof that
the implementation achieves its goal.

Check that the problem exists, the mechanism achieves the objective, and the
change preserves relevant acceptance criteria, contracts, and non-goals.
Consider responsibility placement, ownership, scope, and complexity when they
affect the result. Evaluate new public options, defaults, and authorization
boundaries against the requested experience; do not invent product controls as
fixes without a demonstrated need.

Require replacing the central approach only when local corrections cannot
make it acceptable. Explain the decisive evidence and a feasible alternative.
In that case, prioritize the structural problem and independent critical risks
instead of cataloguing repairs to code that should be replaced.

## Review Personas

Use the personas below for their distinct questions. Read each
applicable perspective before reviewing; do not invent findings to fill a role.
Design Coherence and Taste inform the approach assessment. The other personas
investigate the implementation after that assessment.

| Persona / perspective | Apply when these change |
| --- | --- |
| [Architect](perspectives/architect.md) | Ownership, interfaces, dependencies |
| [Taste](perspectives/taste.md) | Concepts, state, lifecycle, persistence, abstractions |
| [Code Quality](perspectives/code-quality.md) | Behavior, nontrivial control flow |
| [Devil's Advocate](perspectives/devils-advocate.md) | Trust, failures, concurrency, input |
| [Operations](perspectives/operations.md) | Persistence, deployment, services, resources |
| [Test Quality](perspectives/test-quality.md) | Tests, or a candidate's regression coverage |
| [Design Coherence](perspectives/coherence.md) | Explicit requirements are supplied |

Use independent subagents for applicable personas whenever delegation is
available, including a separate Taste reviewer for design changes. Run
independent passes in parallel within available concurrency. If delegation is
unavailable, apply the same perspectives sequentially and report the limitation.

Give every reviewer the same objective, scope, base/head, changed-file list,
relevant intent sources and access to the actual diff and source. Assign a
persona rather than an arbitrary file slice; cross-file defects require tracing
the whole affected flow. Reviewers return a brief assessment, checked paths,
candidate findings with evidence, and unresolved questions. They do not modify
files or remote state. The primary reviewer owns the final decision.

## Investigate Candidates

Trace changed behavior through callers, consumers, state transitions and error
paths. For asynchronous or concurrent flows, follow the complete runtime path:
what happens before the first yield, state visible between yields, guards,
early returns, callbacks, cancellation and cleanup. Verify comments and claimed
ordering against that trace. When interface semantics change, find existing
callers, including previously ignored inputs that now take effect.

Keep a finding only when the change introduced or newly activated a material
problem, a reachable trigger has concrete impact, and source or execution
evidence establishes it. Verify assumptions against relevant code and run
focused checks when they help distinguish a defect from a plausible concern.
Do not run destructive tests or modify reviewed source to prove a finding.
Treat persona output as candidates, not established findings. Recheck material
claims against source and existing guards. Reviewer agreement does not establish
correctness; resolve disagreements with a concrete trace or check, and disclose
any uncertainty that prevents a decision.

Deduplicate by root cause. Fold missing regression coverage into the underlying
functional finding. Omit cosmetic preferences, routine cleanup, generic hardening,
and speculative future work. Do not search unchanged code for latent defects;
mention an encountered pre-existing issue separately only when useful, without
attributing it to this change.

For follow-up reviews, inspect the fixes and affected behavior against current
code. Revalidate supplied findings and report remaining or newly introduced
problems. No persisted finding IDs or closure ledger are required.

## Report

Lead with an explicit decision for the reviewed scope:

- `GO / proceed`: the approach achieves the objective and no material blockers
  remain within that scope.
- `NO-GO / fix`: the approach is viable, but bounded corrections are required.
- `NO-GO / replace`: local corrections cannot make the central approach viable;
  identify the decisive evidence and a feasible replacement.
- `INCONCLUSIVE`: missing intent, evidence or access prevents a supported
  decision; state exactly what remains unverified.

Rate the approach separately as `sound`, `salvageable` or `misguided`; omit the
rating when evidence is insufficient. A partial-scope decision never establishes
that the whole changeset is ready to merge.

State the review basis: objective and intent source, target, base/head (or local
`HEAD`), exclusions and applied personas. Include short reviewer assessments
when they explain the decision, and material disagreements with their resolution.
Include Taste's strongest one or two concrete alternatives in the approach
assessment when they materially simplify the design. Label them as proposals,
separate from defect findings; they receive no severity or finding ID. A Taste
preference alone does not justify `NO-GO`; a verified material failure can.
For each finding, ordered by impact and labeled `F001`, `F002`, etc., provide:

- A short title and severity: critical, high, or medium.
- A precise file and line reference, or the relevant cross-file locations.
- The trigger, resulting impact, and evidence establishing the defect.
- The required observable correction; prescribe an implementation only when
  the evidence requires it.
- The contributing personas and checks supporting the claim. A testing gap
  needs a concrete setup → action → assertion and the regression it catches.

Severity measures impact: `critical` means catastrophic security, data or
availability failure; `high` means broken core behavior or a likely severe
failure; `medium` means a bounded material defect. Do not inflate severity
because several reviewers agree.

Explain any approach concern, then summarize checks actually performed and
material limitations. Distinguish inspected source and executed checks from
supplied descriptions or reported results. If no actionable findings remain,
say so directly. Passing review does not establish correctness outside the
inspected scope.

Return the review in chat. Do not edit source, change branches, post comments,
commit, or write artifacts as part of review. If the user explicitly requests
saved output, use the artifact skill to save the completed review separately.
