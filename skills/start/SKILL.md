---
name: start
description: >
  Create a new Graphite branch. Use when beginning a new feature, starting fresh work, or needing a new
  branch for a task. Triggers: /start, "start new branch", "begin work on".
allowed-tools: Bash
argument-hint: "<branch-name>"
---

# Start

Create a new Graphite branch.

## Arguments

- `<branch-name>` — name for the new branch

## Steps

1. **Parse arguments**
   - Extract branch name from `$ARGUMENTS`
   - If no branch name → tell user: `/skill:start <branch-name>`, stop

2. **Normalize branch name**
   - Prefix with `jm/` if not already prefixed

3. **Check working directory**
   - Run `git status --porcelain`
   - If uncommitted changes exist → warn user but continue

4. **Create Graphite branch**
   - Run `gt create <branch-name>`

5. **Confirm completion**
   - Report branch created
   - Suggest `/skill:implement` to start building. Mention `/skill:research`
     only when the user wants a durable proposal.
