---
name: submit
description: >
  Use this skill to push Graphite stack changes and create or update PRs. Replaces git push
  and gh pr create for stack workflows. Triggers: push, ship it, send this up, submit,
  update PRs, create PR, push stack, send PRs.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gt:*)"
  - "Bash(git status)"
  - "Bash(git branch:*)"
  - Skill
---

# Submit Graphite Stack

Push the Graphite stack and create or update PRs.

## Modes

| Mode | Command | When |
| --- | --- | --- |
| **Default** | `gt ss -u` | Always, unless user explicitly asks otherwise |
| Single PR | `gt submit` | User explicitly says "submit this PR" or "update this PR" |
| Create new | `gt ss` | User explicitly says "create PR" or "create PRs" |

Default is `gt ss -u` (stack, update-only). This avoids accidentally creating PRs for WIP branches.

## Steps

1. Check stack health: `gt log --stack 2>&1`.
   - If restack is needed, use the `restack` skill first.
2. Submit with the selected mode:

   ```bash
   gt ss -u 2>&1
   # or gt submit / gt ss when explicitly requested
   ```

3. Refresh PR descriptions for every submitted PR:
   - After Graphite has created or updated PRs, run `Skill(pr-descr)` for each affected PR so the title and body match the final branch diff.
   - This applies to `gt ss -u`, `gt submit`, and `gt ss`; update-only PRs may still have stale descriptions.
4. Report Graphite URLs (`app.graphite.com/...`) for updated PRs. Do not report GitHub URLs as the primary result.
