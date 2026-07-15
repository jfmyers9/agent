---
name: git-surgeon
description: >
  Perform deterministic, non-interactive hunk-level Git staging, unstaging,
  and explicitly approved discards through the git-surgeon CLI.
allowed-tools: Bash
user-invocable: false
---

# Git Surgeon

Use the installed `git-surgeon` CLI for selective text-diff operations. Do not
construct or apply patches yourself.

## Workflow

1. Run `git-surgeon list --view <staged|unstaged> --json` immediately before
   selecting hunks. IDs describe only that fresh diff snapshot.
2. Use `git-surgeon show <id> --json` when the complete hunk is needed to
   confirm intent.
3. Run one operation with all selected IDs so the CLI checks and applies them
   atomically:

   ```sh
   git-surgeon stage <id>...
   git-surgeon unstage <id>...
   git-surgeon discard --yes <id>...
   ```

4. Inspect a fresh list and `git status --short` to report the result.

The CLI accepts only modified, tracked text files. It reports and excludes
binary files, submodules, additions, deletions, renames, copies, type changes,
and mode changes. It preserves unrelated index and working-tree changes and
never commits.

Discard is destructive. Pass `--yes` only after the user explicitly approves
the freshly listed IDs. If an ID is stale or missing, re-list; require renewed
approval before discarding any replacement ID.
