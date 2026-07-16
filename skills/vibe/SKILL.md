---
name: vibe
description: >
  Deliver one explicitly scoped code change end to end through branch creation,
  implementation, review and fixes, verification, commit, and Graphite
  submission. Invoke only as /skill:vibe or $vibe for autonomous one-shot work.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<change> [--dry-run] [--ready] [--stack]"
---

# Vibe

Deliver one clean changeset from request to pull request without creating a
pipeline artifact.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `<change>` — required scope, acceptance criteria, or named existing artifact.
- `--dry-run` — inspect and report the execution approach without changing any
  local or remote state.
- `--ready` — publish the submitted pull request; otherwise leave new pull
  requests in draft.
- `--stack` — submit descendants with the current Graphite branch.

Invocation authorizes the bounded `$gt create`, `$implement`, `$fix`, `$commit`,
and `$submit` actions below. A durable `$review` and its verification are
authorized only when the user explicitly includes `$review`. Vibe does not
authorize Graphite sync, force-pushes, unrelated changes, or publishing without
`--ready`.

## Workflow

1. Parse only the arguments above and require a concrete change. Read repository
   instructions, inspect the worktree and Graphite stack, and identify relevant
   checks. For execution, require a clean baseline and a configured Graphite
   repository; do not stash or absorb existing work.
2. With `--dry-run`, return the scope, expected branch, approach, risks, checks,
   and submission target. Do not create a branch or artifact, edit, commit, or
   submit.
3. When execution starts on trunk, derive a concise branch name and apply the
   `$gt create` contract. On an existing topic branch, keep that branch.
4. Research uncertainties in session, then apply `$implement` to the request or
   named artifact. Do not create a proposal unless the user also explicitly
   invokes `$research`; when invoked, use its `--auto` mode.
5. Review the complete diff in session for correctness, compatibility, security,
   reliability, tests, and maintainability, using the review decision and
   materiality contract. Revalidate actionable findings and apply `$fix`. When
   the user explicitly requested a durable review, create it with
   `$review --local`, then close that same review with `$review --verify` after
   fixes; otherwise leave any artifact untouched and recheck only the fixes and
   affected paths in session. On `NO-GO / replace`, stop submission; discard or
   reimplement the approach, then perform a fresh review. On `NO-GO / fix`,
   continue the bounded fix/verification loop or stop with the unresolved IDs.
   Do not proceed until a full-scope decision is `GO / proceed` with zero
   unresolved `F` findings.
6. Run focused checks during implementation and the repository's required final
   checks afterward. Do not commit with known relevant failures.
7. Apply `$commit`, staging only paths changed by this run. Require a clean
   worktree after the commit, then apply `$submit`, forwarding `--stack` and
   `--ready` when present. Submission defaults to a draft pull request.
8. On success, report the change, checks, commit, and pull request. On a genuine
   blocker, stop at the current stage and report the evidence and exact action
   needed without undoing completed work.
