---
name: research
description: >
  Research topics, investigate codebases, and create Plannotator-gated
  blueprint proposals. Triggers: 'research', 'investigate', 'explore'.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<topic or question> | --continue | --discard [slug] | --depth <medium|high|max> | --auto | --no-tasks"
---

# Research

Research a topic and write one `spec/` blueprint proposal as the durable
source of truth for implementation.

@rules/blueprints.md, @rules/plannotator-gates.md, and
@rules/harness-compat.md apply.

## Arguments

- `<topic>` — new research topic
- `--continue` — resume the most recent spec blueprint
- `--discard [slug]` — delete the most recent or matching spec
  blueprint
- `--depth <medium|high|max>` — thoroughness, default `medium`
- `--auto` — bypass Plannotator gates, used by `/skill:vibe`
- `--no-tasks` — do not create project tasks after final approval

## Blueprint

Create proposal specs with:

```bash
file=$(blueprint create spec "<topic>" --status spec_review --depth <level>)
```

Expected body:

```markdown
## Research Notes

<validated current-state notes, paths, constraints>

## Spec

### Problem

### Recommendation

### Architecture Context

### Risks

### Challenges

## Plan

**Phase 1: <name>**

- Files: <paths>
- Approach: <what changes>
- Steps:
  1. <action, path, done signal>
- Done signal: <observable result>
- Verify: <command or manual check>

## Approval History

- <timestamp> — spec approved | plan approved | revised from
  Plannotator feedback
```

Use frontmatter status for progress:

- `spec_review` — spec slice drafted; awaiting Plannotator gate
- `spec_approved` — spec slice accepted; plan slice may be drafted
- `plan_review` — plan slice drafted; awaiting Plannotator gate
- `approved` — proposal ready for `/skill:implement`

Run `blueprint commit spec <slug>` after every blueprint write or
status change. If it fails, stop and show the error.

When project task tools are available, approved proposals may also be
imported into project tasks. These tasks are an execution queue linked
by `source_blueprint`; the blueprint remains the durable plan.

## Workflow

### 1. Resolve Work

- `--discard`: find via `blueprint find --type spec [--match <slug>]`,
  delete it, run `blueprint commit spec <slug>`, report.
- `--continue`: find the latest spec via `blueprint find --type spec`,
  read it, and resume from frontmatter `status`.
- New topic: parse flags, derive topic text, create a new spec
  blueprint.

### 2. Research

Use targeted `bash`/`read` calls. Do not dump broad files or logs.

Depth guidance:

- `medium`: key files and architecture, 3-5 phases
- `high`: all relevant files, 2-level call chains, line refs, 5-7
  phases
- `max`: exhaustive affected modules, dependency graph, annotated
  snippets, 7+ phases

Research output must include:

- Current behavior and relevant file paths
- Existing patterns to preserve
- Constraints, risks, and edge cases
- Candidate implementation approach
- Verification commands or checks

Spot-check at least three architectural claims against source before
writing the spec.

### 3. Write Spec Slice

Write a timeless target-state spec:

- **Problem** — current gap or failure
- **Recommendation** — target behavior in present tense; no transition
  verbs like "add" or "replace"
- **Architecture Context** — target module roles and interactions
- **Risks** — edge cases, failure modes, constraints
- **Challenges** — 1-3 devil's-advocate concerns, or "None"

Set status to `spec_review`, write the blueprint, and commit.

If `--auto` is absent, run the Plannotator gate:

```bash
plannotator annotate "$file" --gate
```

- Approved: append/update `## Approval History`, set status to
  `spec_approved`, commit, and continue to planning.
- Feedback: revise only the affected blueprint content, append/update
  `## Approval History`, commit, and rerun the same gate.
- Dismissed: leave status `spec_review`, commit any revisions already
  made, and stop with `/skill:research --continue`.

If `--auto` is present, set status to `spec_approved`, commit, and
continue without opening Plannotator.

### 4. Write Plan Slice

After spec approval, write a phased plan in the same blueprint. Every
phase must include:

- Files to read/modify/create
- Approach
- Ordered steps
- Done signal
- Verification

Set status to `plan_review`, write the blueprint, and commit.

If `--auto` is absent, run the Plannotator gate on the same file:

```bash
plannotator annotate "$file" --gate
```

- Approved: append/update `## Approval History`, set status to
  `approved`, commit, then import tasks when enabled.
- Feedback: revise only the affected plan/spec content, append/update
  `## Approval History`, commit, and rerun the same gate.
- Dismissed: leave status `plan_review`, commit any revisions already
  made, and stop with `/skill:research --continue`.

If `--auto` is present, set status to `approved`, commit, then import
tasks when enabled.

### 5. Import Tasks

Only after status is `approved`, and only if `--no-tasks` is absent and
project task tools are available:

1. Call `task_import_blueprint(match: <blueprint path or slug>)`.
2. Call `task_list(source_blueprint: <blueprint slug>, all: false)` to
   confirm the imported execution queue.
3. Run `blueprint commit spec <slug>` again so the task store is synced
   with the approved blueprint if it lives under the blueprints repo.

If task tools are unavailable or import fails, report the blueprint as
approved and continue; do not block approval on task creation.

## Output

Keep user-facing output concise:

```text
Spec/Plan: <path>
Status: <status>
Tasks: <imported|unavailable|skipped>
Next: /skill:implement
```
