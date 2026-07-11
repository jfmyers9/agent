---
name: submit
description: >
  Restack Graphite branches and create or update pull requests only when the
  user explicitly invokes /submit or asks to use Graphite/stack submission.
  Leaves new PRs in draft by default. Triggers: /submit, "Graphite submit",
  "stack submit".
allowed-tools: Bash
argument-hint: "[--stack] [--sync-only] [--ready]"
---

# Submit

Prepare and submit the current Graphite branch or stack.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `--stack` — include descendants of the current branch
- `--sync-only` — restack locally and stop without pushing or updating PRs
- `--ready` — publish submitted PRs instead of leaving new PRs in draft

`--sync-only` is retained as the public flag name, but it performs a Graphite
restack; it does not run the repository-wide `gt sync` operation.

## Workflow

1. Parse only the three supported flags. Reject unknown arguments and reject
   `--ready` with `--sync-only` because no PR will be updated.
2. Verify that `gt` is available and that the path from
   `git rev-parse --git-path .graphite_repo_config` exists; do not invoke `gt`
   merely as a detector. Verify the current branch is not trunk when a submit
   is requested.
3. Run `git status --short`. If the worktree or index is not clean, report the
   files and stop before restacking.
4. Restack with `gt restack --downstack --no-interactive` so the current branch
   and every ancestor that `gt submit` may update are prepared. With `--stack`,
   use `gt restack --no-interactive` to prepare descendants too. On conflicts,
   show the affected branch and Graphite's recovery guidance, then stop without
   submitting.
5. If `--sync-only` was supplied, report the completed restack and stop.
6. Build the submit command from explicit arguments:
   - Start with `gt submit --no-stack --no-interactive --no-edit` so the default
     cannot include descendants through prompts or configuration.
   - Replace `--no-stack` with `--stack` only when requested.
   - Add `--draft` by default so new PRs are drafts.
   - Replace `--draft` with `--publish` only for explicit `--ready`.
   - Never add `--force`; let Graphite use its guarded default update behavior.
7. Run the command once. On failure, report the error without closing PRs,
   deleting branches, force-pushing, or falling back to `gh pr create`.
8. Display every PR URL reported by Graphite and summarize which branches were
   created, updated, left draft, or published.
