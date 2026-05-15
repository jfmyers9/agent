---
name: submit
description: >
  Use this skill to push Git-Spice stack changes and create or update Change Requests.
  Replaces git push and gh pr create for stack workflows. Triggers: push, ship it, send
  this up, submit, update PRs, create PR, push stack, send PRs.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(git status)"
  - "Bash(git branch:*)"
  - Skill
---

# Submit Git-Spice Stack

Push the Git-Spice stack and create or update Change Requests.

Command contracts are based on upstream `doc/includes/cli-reference.md`, which documents `gs stack submit`, `gs ss`, and `--update-only` / `-u`.

## Modes

| Mode | Command | When |
| --- | --- | --- |
| **Default** | `gs stack submit --update-only` or `gs ss -u` | Always, unless user explicitly asks otherwise |
| Single branch | `gs branch submit --update-only` | User explicitly says "submit this branch" or "update this branch" |
| Create new | `gs stack submit` or `gs ss` | User explicitly says "create PR", "create CR", or "create PRs" |

Default is update-only. `--update-only` is used to update existing Change Requests and skip branches that would create new Change Requests, avoiding accidental publication of WIP stack branches.

## Steps

1. Check stack state: `gs log short 2>&1`.
2. Submit with the selected mode:

   ```bash
   gs stack submit --update-only 2>&1
   # or gs ss -u 2>&1
   ```

3. Refresh PR/CR descriptions for every submitted GitHub PR:
   - After Git-Spice has created or updated Change Requests, run `Skill(pr-descr)` for each affected GitHub PR so the title and body match the final branch diff.
   - This applies to update-only and create modes; existing Change Requests may still have stale descriptions.
4. Report created or updated Change Request URLs.
