---
name: vibe
description: >
  Fully autonomous development workflow from prompt to commit.
  Chains research → implement → commit.
  Triggers: /vibe, "vibe this", "autonomous workflow".
allowed-tools: Bash, Read, Glob, Skill, TaskCreate, TaskUpdate, TaskGet, TaskList
argument-hint: "<prompt> [--no-branch] [--continue] [--dry-run]"
---

# Vibe

Run the full development pipeline from a single prompt.

## Plan Directory

@rules/blueprints.md.

## Arguments

- `<prompt>` — what to build (required unless `--continue`)
- `--no-branch` — skip branch creation, use current branch
- `--continue` — resume a failed pipeline from last completed stage
- `--dry-run` — research only, stop before implement

## Pipeline

```
/start → /research → /implement → /commit
```

Each stage verifies success before proceeding. Failures halt
with a clear report.

## Step 1: Parse Arguments

Extract from `$ARGUMENTS`:

- `<prompt>`: everything except flags
- `--no-branch`: boolean
- `--continue`: boolean
- `--dry-run`: boolean

If no prompt and no `--continue` → tell user:
`/vibe <what to build>`, stop.

## Step 2: Resume Check

If `--continue`:

1. `TaskList()` → find task with `metadata.type == "vibe"`
   and `status == "in_progress"`
2. If found → read `metadata.vibe_stage` to determine resume point
3. Read `metadata.vibe_prompt` as the prompt
4. Skip to the stage after `vibe_stage` (see Step 4)
5. If not found → tell user no pipeline to resume, stop

## Step 3: Create Pipeline Tracker

```
TaskCreate(
  subject: "Vibe: <prompt (truncated to 60 chars)>",
  description: "Autonomous pipeline for: <full prompt>",
  activeForm: "Vibing: <prompt (truncated to 40 chars)>",
  metadata: {
    type: "vibe",
    vibe_prompt: "<full prompt>",
    vibe_stage: "started",
    priority: 1
  }
)
TaskUpdate(taskId, status: "in_progress")
```

## Step 4: Execute Pipeline

Run stages sequentially. After each stage succeeds, update
`metadata.vibe_stage` via TaskUpdate before proceeding.

### Stage 1: Branch (skip if `--no-branch`)

Generate slug from prompt (lowercase, hyphens, max 40 chars).

```
Skill("start", args="jm/<slug>")
```

**Verify**: `git branch --show-current` returns the new branch.
**Update**: `TaskUpdate(trackerId, metadata: { vibe_stage: "branch" })`
**Report**: `[1/4] Branch: jm/<slug>`

If on a non-main branch already, skip and report:
`[1/4] Branch: skipped (already on <branch>)`

### Stage 2: Research

```
Skill("research", args="<prompt>")
```

**Verify**: Plan file exists in `~/workspace/blueprints/<project>/`.
Check via `ls -t ~/workspace/blueprints/<project>/*.md | head -1`.
**Update**: `TaskUpdate(trackerId, metadata: { vibe_stage: "research" })`
**Report**: `[2/4] Researched: plan at <path>`

If `--dry-run` → stop here. Report plan file, suggest
`/implement` or `/vibe --continue` when ready.

### Stage 3: Implement

```
Skill("implement")
```

**Verify**: `TaskList()` → all children of epic have
`status == "completed"`.
**Update**: `TaskUpdate(trackerId, metadata: { vibe_stage: "implement" })`
**Report**: `[3/4] Implemented: N/N tasks completed`

If some tasks failed, report failures but continue to commit
if any code was changed (`git diff --stat` is non-empty).

### Stage 4: Commit

Check `git diff --stat` first. If empty → skip, report
`[4/4] Commit: skipped (no changes)`.

```
Skill("commit")
```

**Verify**: `git log -1 --oneline` shows a new commit.
**Update**: `TaskUpdate(trackerId, metadata: { vibe_stage: "commit" })`
**Report**: `[4/4] Committed: <commit oneline>`

## Step 5: Finalize

```
TaskUpdate(trackerId, status: "completed")
```

Report full summary:

```
Pipeline complete:
[1/4] Branch: jm/<slug>
[2/4] Researched: plan at <path>
[3/4] Implemented: N/N tasks completed
[4/4] Committed: <commit oneline>

Next: `/submit` to create PR
```

## Error Handling

If ANY stage fails:

1. Do NOT update `vibe_stage` (it stays at last successful stage)
2. Leave tracker task in_progress
3. Report:
   ```
   Pipeline halted at stage N (<stage-name>).
   Error: <details>

   Completed:
   [1/4] Branch: ...
   [2/4] Researched: ...

   Resume: `/vibe --continue`
   Or run manually: `/<failed-skill> [args]`
   ```

## Stage Count

- With branch: 4 stages (`[N/4]`)
- With `--no-branch`: 3 stages (`[N/3]`)
- With `--dry-run`: 2 stages (`[N/2]`) or 1 (`[N/1]` if also
  `--no-branch`)

Adjust the `[N/M]` denominator based on active flags.
