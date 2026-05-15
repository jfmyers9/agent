---
name: restack
description: >
  Use this skill to restack/rebase Git-Spice branches and resolve conflicts. Replaces raw
  git rebase for stack workflows. Triggers: restack, rebase, rebase on main, branches out
  of date, resolve conflicts.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(git add:*)"
  - "Bash(git status)"
  - Read
  - Edit
  - Glob
  - Grep
---

# Restack Git-Spice Stack

Restack Git-Spice branches onto their bases and resolve conflicts.

Command contracts are based on upstream `doc/includes/cli-reference.md`, which documents `gs stack restack` and shorthand `gs sr`.

## Steps

1. Run `gs stack restack 2>&1`.
   - Shorthand: `gs sr 2>&1`.
2. If clean, report which branches were restacked.
3. If conflicts occur, loop until resolved:
   - Read each conflicted file in full before editing.
   - Identify all conflict markers: `<<<<<<<`, `=======`, `>>>>>>>`.
   - Resolve every conflict region in a single edit; never leave partial markers.
   - Run `rg -c '<<<<<<<' <file>` to verify no conflict markers remain.
   - `git add <file>` each resolved file.
   - Continue with the Git-Spice command indicated by the CLI output.
   - If new conflicts appear on another branch, repeat.
4. Report branches restacked, conflicts resolved, and any issues.

If conflict resolution is ambiguous, abort using the Git-Spice command indicated by the CLI output and report the blocker to the user.
