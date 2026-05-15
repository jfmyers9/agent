---
name: restack
description: >
  Use this skill to restack/rebase Graphite branches and resolve conflicts. Replaces raw git
  rebase for stack workflows. Triggers: restack, rebase, rebase on main, branches out of
  date, resolve conflicts.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gt:*)"
  - "Bash(git add:*)"
  - "Bash(git status)"
  - Read
  - Edit
  - Glob
  - Grep
---

# Restack Graphite Stack

Rebase Graphite stack branches onto their updated parents and resolve conflicts.

## Steps

1. Run `gt restack 2>&1`.
2. If clean, report which branches were restacked.
3. If conflicts occur, loop until resolved:
   - Read each conflicted file in full before editing.
   - Identify all conflict markers: `<<<<<<<`, `=======`, `>>>>>>>`.
   - Resolve every conflict region in a single edit; never leave partial markers.
   - Run `rg -c '<<<<<<<' <file>` to verify no conflict markers remain.
   - `git add <file>` each resolved file.
   - Run `gt continue 2>&1`.
   - If new conflicts appear on another branch, repeat.
4. Report branches restacked, conflicts resolved, and any issues.

## Conflict Resolution Rules

- Take the semantically correct merge; combine both sides' intent when possible.
- For renames/refactors, apply the rename to the newer code from the child branch.
- If resolution is ambiguous, run `gt abort` and report the blocker to the user.
