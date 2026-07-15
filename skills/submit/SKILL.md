---
name: submit
description: >
  Restack Graphite branches and create or update pull requests only when the
  user explicitly invokes /submit or asks to use Graphite/stack submission.
  Supports read-only submission previews and leaves new PRs in draft by
  default. Triggers: /submit, "Graphite submit", "stack submit".
allowed-tools: Bash
argument-hint: >
  [--stack] [--restack-only] [--sync-only] [--dry-run] [--ready]
---

# Submit

Prepare and submit the current Graphite branch or stack.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `--stack` — include descendants of the current branch
- `--restack-only` — restack locally and stop without pushing or updating PRs
- `--sync-only` — deprecated compatibility alias for `--restack-only`
- `--dry-run` — preview submission without restacking, pushing, or changing PRs
- `--ready` — publish submitted PRs instead of leaving new PRs in draft

Neither restack-only flag runs the repository-wide `gt sync` operation.

## Workflow

1. Parse only the supported flags. Normalize `--sync-only` to
   `--restack-only` and report that the alias is deprecated; reject both
   spellings together. Reject unknown arguments, `--ready` with
   `--restack-only`, and `--dry-run` with `--restack-only`.
2. Verify that `gt` is available and that the path from
   `git rev-parse --git-path .graphite_repo_config` exists; do not invoke `gt`
   merely as a detector. Verify the current branch is not trunk when a submit
   is requested.
3. Run `git status --short`. If the worktree or index is not clean, report the
   files and stop before restacking.
4. For a submission, build the command from explicit arguments:
   - Start with `gt submit --no-stack --no-interactive --no-edit` so the default
     cannot include descendants through prompts or configuration.
   - Replace `--no-stack` with `--stack` only when requested.
   - Add `--draft` by default so new PRs are drafts.
   - Replace `--draft` with `--publish` only for explicit `--ready`.
   - Add `--dry-run` only when requested.
   - Never add `--force`; let Graphite use its guarded default update behavior.
5. With `--dry-run`, run that command once, report the branches and PRs
   Graphite would submit, and stop. Do not run `gt restack` or any other
   mutating command in this path.
6. Restack with `gt restack --downstack --no-interactive` so the current branch
   and every ancestor that `gt submit` may update are prepared. With `--stack`,
   use `gt restack --no-interactive` to prepare descendants too. On conflicts,
   show the affected branch and Graphite's recovery guidance, then stop without
   submitting.
7. With `--restack-only`, report the completed restack and stop.
8. Run the submit command once. On failure, report the error without closing
   PRs, deleting branches, force-pushing, or falling back to `gh pr create`.
9. Display every PR URL reported by Graphite and summarize which branches were
   created, updated, left draft, or published.
