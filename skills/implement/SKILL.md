---
name: implement
description: >
  Execute implementation plans from blueprint files. Triggers:
  'implement', 'build this', 'execute plan', 'start work'.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[blueprint-slug-or-path] [--no-report]"
---

# Implement

Implement the latest approved blueprint. Blueprints remain the durable
source of truth; project tasks are the preferred fine-grained execution
queue when `task_*` tools are available.

@rules/blueprints.md and @rules/harness-compat.md apply.

## Arguments

- `[blueprint-slug-or-path]` — optional spec/plan/review blueprint
- `--no-report` — skip automatic report generation
- `--no-tasks` — skip project task import/use even if task tools exist

## Workflow

### 1. Resolve Blueprint

- If an explicit file path exists, use it.
- Else if an argument remains, run:
  `blueprint find --type plan,spec,review --match <arg>`
- Else run: `blueprint find --type plan,spec,review`
- Select the most recent file whose status is not `complete`.
- If none exists, stop and suggest `/skill:research`.

Read the file and skip YAML frontmatter. Prefer an `approved` plan, but
allow `plan_review` or `draft` when the user explicitly requested the
file/slug.

### 2. Parse Plan

Parse phases from the blueprint body:

- `**Phase N: ...**`
- `### Phase N: ...`
- `## Phase N: ...`

If no phases exist, treat the entire `## Plan`, `## Feedback Analysis`,
or `## Findings` section as one phase.

### 2.5. Initialize Project Tasks When Available

If `--no-tasks` is absent and project task tools are available:

1. Import the blueprint into tasks:
   `task_import_blueprint(match: <blueprint path or slug>)`.
2. List active linked tasks:
   `task_list(source_blueprint: <blueprint slug>, all: false)`.
3. Use linked tasks as the execution queue. Blueprints still own the
   plan, implementation notes, reports, and completion status.

If task tools are unavailable or import fails, continue with the
phase-only workflow. Do not stop solely because tasks are unavailable.

Each phase should produce:

- phase title
- referenced files
- required changes
- verification command/check

### 3. Implement Work

If linked project tasks are available, work task-by-task in board order:

1. Pick the first active task linked to the blueprint whose blockers are
   resolved.
2. Mark it active:
   `task_update(id: <id>, assigned_to: "current", status: "in_progress")`.
3. Read referenced files first.
4. Make the smallest change that satisfies the task/phase.
5. Stay within files named or clearly implied by the blueprint/task.
6. Run the task or phase verification. If none is specified, run the
   smallest relevant test, typecheck, lint, or smoke command available.
7. Mark success:
   - `feature`/`bug` tasks: `status: "in_review"`
   - `chore`/`epic` tasks: `status: "done"`
8. If blocked, mark the task `status: "rejected"` or leave it
   `in_progress` with a clear blocker note in the blueprint, then stop.
9. Append/update an `## Implementation Notes` section in the blueprint:
   ```markdown
   ### Task <id>: <title>

   - Status: complete | blocked
   - Files changed: <paths>
   - Verification: <command> — <result>
   - Notes: <deviations or blockers>
   ```
10. Run `blueprint commit <type> <slug>` after the blueprint write.

If project tasks are not available, use the phase fallback. For each
phase, in order:

1. Read referenced files first.
2. Make the smallest change that satisfies the phase.
3. Stay within files named or clearly implied by the blueprint.
4. Run the phase verification if specified.
5. If no verification is specified, run the smallest relevant test,
   typecheck, lint, or smoke command available.
6. Append/update an `## Implementation Notes` section in the blueprint:
   ```markdown
   ### Phase N: <title>

   - Status: complete | blocked
   - Files changed: <paths>
   - Verification: <command> — <result>
   - Notes: <deviations or blockers>
   ```
7. Run `blueprint commit <type> <slug>` after the blueprint write.

If a task or phase is blocked, stop after recording the blocker.

### 4. Complete Blueprint

When all linked tasks or all phases are complete:

```bash
blueprint status "$file" complete
blueprint commit <type> <slug>
```

If task tools were used, call
`task_export_blueprint(source_blueprint: <blueprint slug>)` and include
the summary in implementation notes before the final blueprint commit.

Unless `--no-report` was passed, read `skills/report/SKILL.md` and
follow it to create a report blueprint.

### 5. Report

Show:

- blueprint path
- tasks/phases completed / blocked
- files changed
- verification commands and results
- next step: `/skill:review`, `/skill:commit`, or blocker details

## Rules

- Use project task tools only as a blueprint-linked execution queue.
- Do not create harness-native task/team/subagent state.
- Do not spawn subagents or teams.
- Prefer vertical, testable changes.
- Preserve user changes; inspect `git status` before large edits.
