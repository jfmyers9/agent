---
name: research
description: >
  Research topics, investigate codebases, and create blueprint-backed
  specifications and implementation plans. Triggers: 'research',
  'investigate', 'explore'.
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "<topic or question> | --continue | --discard [slug] | --depth <medium|high|max> | --auto"
---

# Research

Research a topic, write a `spec/` blueprint, then use that blueprint
as the durable source of truth for implementation.

@rules/blueprints.md and @rules/harness-compat.md apply.

## Arguments

- `<topic>` — new research topic
- `--continue` — resume the most recent spec blueprint
- `--discard [slug]` — delete the most recent or matching spec
  blueprint
- `--depth <medium|high|max>` — thoroughness, default `medium`
- `--auto` — skip approval gates, used by `/skill:vibe`
- `--no-tasks` — do not create project tasks after plan approval

## Blueprint

Create specs with:

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
- Verify: <command or manual check>
```

Use frontmatter status for progress:

- `spec_review` — spec drafted
- `spec_approved` — spec accepted
- `plan_review` — plan drafted
- `approved` — ready for `/skill:implement`

Run `blueprint commit spec <slug>` after every blueprint write or
status change. If it fails, stop and show the error.

When project task tools are available, approved plans may also be
imported into project tasks. These tasks are an execution queue linked
by `source_blueprint`; the blueprint remains the durable plan.

## Workflow

### 1. Resolve Work

- `--discard`: find via `blueprint find --type spec [--match <slug>]`,
  delete it, run `blueprint commit spec <slug>`, report.
- `--continue`: find the latest spec via `blueprint find --type spec`,
  read it, resume from its frontmatter status.
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

### 3. Write Spec

Write a timeless target-state spec:

- **Problem** — current gap or failure
- **Recommendation** — target behavior in present tense; no transition
  verbs like "add" or "replace"
- **Architecture Context** — target module roles and interactions
- **Risks** — edge cases, failure modes, constraints
- **Challenges** — 1-3 devil's-advocate concerns, or "None"

Set status to `spec_review`. If `--auto` is absent, present the spec
and stop for approval.

### 4. Write Plan

After spec approval, write a phased plan. Every phase must include:

- Files to read/modify/create
- Approach
- Ordered steps
- Done signal
- Verification

Set status to `plan_review`. If `--auto` is absent, present the plan
and stop for approval.

### 5. Approve

When plan is accepted, set status to `approved`, commit the blueprint.

If `--no-tasks` is absent and `task_import_blueprint` is available:

1. Call `task_import_blueprint(match: <blueprint path or slug>)`.
2. Call `task_list(source_blueprint: <blueprint slug>, all: false)` to
   confirm the imported execution queue.
3. Run `blueprint commit spec <slug>` again so the task store is synced
   with the approved blueprint if it lives under the blueprints repo.

If task tools are unavailable or import fails, report the blueprint as
approved and continue; do not block approval on task creation.

Report:

```text
Plan: <path>
Tasks: imported | unavailable | skipped
Next: /skill:implement
```

## Output

Keep user-facing output concise:

```text
Spec/Plan: <path>
Status: <status>
Tasks: <imported|unavailable|skipped>
Next: /skill:implement
```
