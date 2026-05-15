---
name: stack
description: >
  Use this skill for Graphite stack status, branch creation, stack navigation, moving changes
  between branches, splitting work into stacked PRs, or general Graphite operations. Replaces
  raw git checkout -b, git rebase, git push, and gh pr create for stack workflows.
user-invocable: true
allowed-tools:
  - "Bash(gt:*)"
  - "Bash(git status)"
argument-hint: "[log|info|amend|up|down|top|bottom|create|move|fold|delete|...] [flags]"
---

# Graphite Stack

Use Graphite for stacked branch workflows in this repository.

## Quick Reference

```bash
# Create — ALWAYS pass a branch name, NEVER pass -m
gt create <branch-name>             # New branch on top of current
gt create <branch-name> -i          # Insert between current and its child

# Navigate
gt up / gt down
gt top / gt bottom
gt log --stack                      # View CURRENT stack only; use by default
gt log                              # View ALL branches

# Modify current branch
gt modify -a
gt squash
gt absorb -af                       # Stage all + auto-distribute fixes

# Advanced
gt fold
gt move --onto <branch>
gt delete

# Recovery
gt continue / gt abort / gt undo
```

## Branch Creation Rules

`gt create` creates a branch on the stack. It is not a commit command.

- Always pass a branch name.
- Never pass `-m` or `-am`.
- Create the branch first, then commit separately with `git commit` or `/commit`.
- Do not use `gt create` to make commits on an existing branch.
- Use `--insert` (`-i`) to create a branch between the current branch and its child.

```bash
# Correct
gt create luan/my-feature
git add -A && git commit -m "feat(scope): add feature"

# Wrong
gt create luan/my-feature -am "feat(scope): add feature"
gt create -m "feat(scope): add feature"
```

## Stack Structure

```text
main (trunk)
  └── feature-1  ← bottom, toward trunk
        └── feature-2
              └── feature-3  ← top, away from trunk
```

- `up` means toward children/top.
- `down` means toward parent/trunk.

## When to Stack

Split large or multi-concern changes into small, independently reviewable PRs. Good split candidates include utility code, new interfaces, tests before behavior changes, mechanical refactors, schema changes, and UI scaffolding.

Before splitting a non-trivial change, present a stack table with PR title and summary for each branch and get user feedback.

## Forbidden Replacements

Never use these raw commands for stack workflows:

| Forbidden | Use instead |
| --- | --- |
| `git checkout -b` | `gt create` |
| `git rebase` | `restack` skill / `gt restack` |
| `git push` / `git push --force` | `submit` skill |
| `gh pr create` | `submit` skill |
