---
name: start
description: >
  Create a clean, empty Graphite branch only when the user explicitly invokes
  /start or asks to use Graphite branch creation. Triggers: /start,
  "Graphite branch", "Graphite start".
allowed-tools: Bash
argument-hint: "<branch-name>"
---

# Start

Create a new Graphite branch without committing existing worktree changes.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `<branch-name>` — new branch name; prefix with `jm/` when absent

## Workflow

1. Extract exactly one branch name from `$ARGUMENTS`. If it is missing, show
   `/skill:start <branch-name>` and stop.
2. Prefix the name with `jm/` unless it already has that prefix. Validate the
   result with `git check-ref-format --branch` and reject an existing local
   branch. Keep the value shell-quoted in every command.
3. Verify that `gt` is available and that the path from
   `git rev-parse --git-path .graphite_repo_config` exists. Do not invoke `gt`
   merely to detect initialization because current versions may create
   metadata. Do not fall back to `git switch -c`.
4. Run `git status --short`. If any staged, unstaged, or untracked changes
   exist, report them and stop: `gt create` can commit staged changes and prompt
   to stage unstaged changes. Ask the user to commit or stash them first rather
   than guessing their destination.
5. Run `gt create <branch-name> --no-interactive`. If it fails, report the
   Graphite error without retrying with different branch semantics.
6. Confirm the current branch with `git branch --show-current` and report the
   created branch.
