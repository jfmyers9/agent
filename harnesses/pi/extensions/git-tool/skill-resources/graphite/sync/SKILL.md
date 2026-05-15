---
name: sync
description: >
  Use this skill to sync a Graphite stack with trunk. Triggers: sync, update from main,
  update from trunk, pull trunk, refresh stack.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gt:*)"
  - "Bash(git status)"
  - Skill
---

# Sync Graphite Stack

Use Graphite to pull trunk updates and restack the current stack. Do not use raw `git pull` plus `git rebase` for stack synchronization.

## Steps

1. Check current stack state: `gt log --stack 2>&1`.
2. Run Graphite sync:

   ```bash
   gt sync 2>&1
   ```

3. If Graphite reports restack conflicts, use the `restack` skill to resolve them.
4. Report the trunk update and branches synchronized.

`gt sync` pulls trunk and restacks. It does not push the stack; use the `submit` skill for pushing or PR updates.
