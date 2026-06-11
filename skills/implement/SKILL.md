---
name: implement
description: >
  Execute approved implementation plans from blueprint files. Triggers:
  'implement', 'build this', 'execute plan', 'start work'.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[blueprint-slug-or-path] [--no-report]"
---

# Implement

Implement an approved blueprint. The blueprint is the durable source of
truth and the execution plan.

@rules/blueprints.md, @rules/human-approval.md,
@rules/harness-compat.md, and @rules/artifact-readability.md apply.

## Arguments

- `[blueprint-slug-or-path]` — optional spec/plan/review blueprint
- `--no-report` — skip automatic report generation

## Workflow

### 1. Resolve Blueprint

- If an explicit file path exists, use it.
- Else if an argument remains, run:
  `blueprint find --type plan,spec,review --match <arg>`
- Else run: `blueprint find --type plan,spec,review`
- Select the most recent file whose frontmatter status is `approved`.
- If none exists, stop and suggest `/skill:research` or
  `/skill:research --continue` for pending `spec_review`/`plan_review`
  blueprints.

Read the file and skip YAML frontmatter. Do not execute `draft`,
`spec_review`, `spec_approved`, or `plan_review` content by default.

If the user explicitly requested an unapproved file or slug, do not make
code changes. Report the blueprint path and status, ask the user to
review it locally, and wait for explicit chat approval or feedback.

### 2. Parse Plan

Parse phases from the blueprint body:

- `**Phase N: ...**`
- `### Phase N: ...`
- `## Phase N: ...`

If no phases exist, treat the entire `## Plan`, `## Feedback Analysis`,
or `## Findings` section as one phase.

Each phase should provide:

- phase title
- referenced files
- required changes
- verification command/check

For multi-phase plans, derive an execution map before editing:

| Phase / Task | Files | True blockers | Can run independently? | Verify |
| ------------ | ----- | ------------- | ---------------------- | ------ |

True blockers exist only when a later task needs files, APIs, schemas,
types, behavior, or verification output from an earlier task. Phase numbers
alone do not make a dependency.

### 3. Implement Work

For each phase, in order:

1. Read referenced files first.
2. Make the smallest change that satisfies the phase.
3. Stay within files named or clearly implied by the blueprint.
4. Run the phase verification if specified.
5. If no verification is specified, run the smallest relevant test,
   typecheck, lint, or smoke command available.
6. Append/update an `## Implementation Notes` section in the blueprint:

   ```markdown
   ## Implementation Notes

   ### Execution Map

   | Phase / Task | Files | True blockers | Can run independently? | Verify |
   | ------------ | ----- | ------------- | ---------------------- | ------ |

   ### Phase N: <title>

   - Status: complete | blocked
   - Files changed: <paths>
   - Verification: <command> — <result>
   - Notes: <deviations or blockers>
   ```

7. Run `blueprint commit <type> <slug>` after the blueprint write.

If a phase is blocked, stop after recording the blocker.

### 4. Complete Blueprint

When all phases are complete:

```bash
blueprint status "$file" complete
blueprint commit <type> <slug>
```

Unless `--no-report` was passed, read `skills/report/SKILL.md` and
follow it to create a report blueprint.

### 5. Report

Show:

- blueprint path
- phases completed / blocked
- files changed
- verification commands and results
- next step: `/skill:review`, `/skill:commit`, or blocker details

## Rules

- Execute only approved blueprints.
- Use explicit chat approval for unapproved blueprints before code
  changes.
- Do not create harness-native task/team/subagent state.
- Do not spawn subagents or teams.
- Prefer vertical, testable changes.
- Preserve user changes; inspect `git status` before large edits.
