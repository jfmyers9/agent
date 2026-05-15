---
name: sync
description: >
  Use this skill to sync a Git-Spice repository with its remote/trunk. Triggers: sync,
  update from main, update from trunk, pull trunk, refresh stack.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(git status)"
  - Skill
---

# Sync Git-Spice Repository

Use Git-Spice to pull latest remote changes and clean up merged Change Request branches. Do not use raw `git pull` plus `git rebase` for stack synchronization.

Command contracts are based on upstream `doc/includes/cli-reference.md`, which documents `gs repo sync`, shorthand `gs rs`, and the `--restack` flag.

## Steps

1. Check current stack state: `gs log short 2>&1`.
2. Run Git-Spice sync:

   ```bash
   gs repo sync --restack 2>&1
   ```

   Shorthand form:

   ```bash
   gs rs --restack 2>&1
   ```

3. If Git-Spice reports restack conflicts, use the `restack` skill to resolve them.
4. Report the remote update, deleted merged branches, and branches synchronized.

`gs repo sync` pulls latest changes from the remote. With `--restack`, it restacks the current stack after syncing. It does not replace the `submit` skill for pushing or Change Request updates.
