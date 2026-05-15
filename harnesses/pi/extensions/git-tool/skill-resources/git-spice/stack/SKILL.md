---
name: stack
description: >
  Use this skill for Git-Spice stack status, branch creation, stack navigation, moving
  changes between branches, splitting work into stacked Change Requests, or general
  Git-Spice operations. Replaces raw git checkout -b, git rebase, git push, and gh pr
  create for stack workflows.
user-invocable: true
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(git status)"
argument-hint: "[log|branch|up|down|top|bottom|create|track|split|...] [flags]"
---

# Git-Spice Stack

Use Git-Spice for stacked branch workflows in this repository.

Command contracts are based on the upstream Git-Spice docs:

- `doc/src/guide/branch.md` documents `gs branch create`.
- `doc/src/cli/shorthand.md` and `doc/includes/cli-shorthands.md` document shorthands such as `gs bc`.
- `doc/includes/cli-reference.md` documents stack submit/restack and repo sync.

## Quick Reference

```bash
# Create branches
gs branch create <name>              # Canonical branch-create command
gs bc <name>                         # Built-in shorthand for branch create
gs branch create <name> --no-commit  # Create branch without committing staged changes

# Navigate and inspect
gs log short                         # Current stack
gs log short --all                   # All tracked branches
gs up / gs down
gs top / gs bottom

# Submit / sync / restack
gs stack submit --update-only        # Update existing Change Requests only
gs ss -u                             # Shorthand update-only submit
gs repo sync                         # Pull latest remote changes and delete merged CR branches
gs rs                                # Shorthand repo sync
gs stack restack                     # Restack current stack
gs sr                                # Shorthand stack restack
```

## Branch Creation Rules

`gs branch create` creates and tracks a branch stacked on the current branch.
By default, staged changes are committed to the new branch; if there are no staged changes, Git-Spice creates an empty commit. Use `--no-commit` when the user wants to create the branch before making the commit.

Canonical and shorthand forms are both valid and are intentionally documented for the trunk safety whitelist:

```bash
gs branch create luan/my-feature
gs bc luan/my-feature
```

Prefer the canonical form in scripts and skill instructions unless the user explicitly asks for shorthand.

## Forbidden Replacements

Never use these raw commands for stack workflows:

| Forbidden | Use instead |
| --- | --- |
| `git checkout -b` | `gs branch create` / `gs bc` |
| `git rebase` | `restack` skill / `gs stack restack` |
| `git push` / `git push --force` | `submit` skill |
| `gh pr create` | `submit` skill |
