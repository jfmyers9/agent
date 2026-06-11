---
name: context
description: >
  Map a codebase, subsystem, feature area, path set, or symbol into a durable
  blueprint report for future reference or handoff to research, debug, review,
  or implementation workflows. Triggers: 'get context', 'map codebase',
  'codebase overview', 'understand this area', 'context report'.
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "<scope> [--depth quick|medium|high|max] [--for general|research|debug|implement|review] [--continue] [--update <slug>] [--link <slug>]"
---

# Context

Create a durable codebase-context blueprint report.

@rules/blueprints.md and @rules/harness-compat.md apply.

## Arguments

- `<scope>` — repo, subsystem, feature, path, symbol, or file set to map.
- `--depth <quick|medium|high|max>` — thoroughness, default `medium`.
- `--for <general|research|debug|implement|review>` — tune handoff notes,
  default `general`.
- `--continue` — resume the latest context report.
- `--update <slug>` — refresh an existing context report.
- `--link <slug>` — link the context report to another blueprint.

## Workflow

### 1. Resolve Work

- For `--continue`, find the latest `report/` blueprint whose topic or body
  identifies it as a context report. Read it and continue from its current
  scope, snapshot, open questions, and status.
- For `--update <slug>`, find the matching report with
  `blueprint find --type report --match <slug>`. Preserve durable notes that
  are still true, refresh snapshot metadata, and mark stale claims explicitly.
- For `--link <slug>`, resolve the source blueprint with
  `blueprint find --type spec,plan,review,report --match <slug>` and link it
  after creating the context report.
- For new work, derive the scope from arguments. If no scope is provided,
  inspect the repository root, README, project metadata, and top-level tree to
  choose a repo-wide scope.
- Create new reports with:

```bash
file=$(blueprint create report "Context: <scope>" --status draft)
```

If a source blueprint was resolved, link it:

```bash
blueprint link "$file" "<source-slug>"
```

### 2. Bound The Scope

- Record included paths, symbols, features, or repo-wide boundaries.
- Record explicit exclusions, especially generated, vendored, build,
  coverage, lockfile, and binary artifacts unless they are the focus.
- If a scope names paths, constrain inspection to those paths plus direct
  callers, callees, tests, configs, and docs needed to explain behavior.
- If a scope names a feature or symbol, search definitions and references
  first, then read only the files needed to trace important flows.
- Prefer symbol-aware tooling when available. Use `Read`, `Glob`, and `Grep`
  for portable inspection. Do not dump broad files or logs.

### 3. Inventory The Area

Collect concise evidence for:

- branch, commit, dirty state, and date
- key docs and config files
- entrypoints
- major modules and ownership boundaries
- important types, schemas, stores, caches, and config
- tests and verification commands
- external interfaces such as CLI, API, UI, events, files, network, or DB

Use source line references for claims that future work may rely on.

### 4. Trace Important Flows

For each major behavior in scope, identify:

1. entrypoint
2. dispatch or orchestration layer
3. data or state transformations
4. side effects
5. output or boundary crossing
6. related tests or verification command

Verify at least three architecture claims against source before writing the
report. Cite each verified claim with file paths and line references.

### 5. Write The Context Report

Write or update the report body with these sections:

```markdown
## Scope

<included boundaries, exclusions, depth, and intended audience>

## Snapshot

- Branch: <branch>
- Commit: <sha>
- Dirty state: <clean or relevant files>
- Date: <timestamp>
- Entry paths: <paths>

## Executive Summary

<5-10 bullets explaining what the area does and how to reason about it>

## Architecture Map

### Main Modules

- `<path>` — role, ownership, key exports/classes/functions

### Runtime Flow

1. <entrypoint>
2. <dispatch/control layer>
3. <state/data transformation>
4. <side effects>
5. <output>

### Data Model / State

- <important types, schemas, stores, caches, config>

### External Interfaces

- <CLI/API/UI/events/files/network/db/etc.>

## Important Code Paths

- `<path:line>` — why it matters

## Patterns To Preserve

- <local conventions, module boundaries, error handling, test style>

## Risks / Sharp Edges

- <coupling, hidden invariants, global state, migrations, slow tests>

## Verification / Useful Commands

```bash
<commands>
```

## Open Questions

- <unknowns worth resolving before changing this area>

## Handoff Notes

### For Research

<assumptions and context a proposal should start from>

### For Debug

<likely fault domains, reproduction hints, and useful commands>

### For Implementation

<likely touchpoints and constraints; not a phased plan>
```

Keep the report descriptive. Do not create an implementation plan, even when
`--for implement` is requested. Capture likely touchpoints and constraints only.

### 6. Complete And Commit

Set the report status to `complete`:

```bash
blueprint status "$file" complete
```

Run commit-on-write after every report write or status change:

```bash
blueprint commit report <slug>
```

If `blueprint commit` exits non-zero, stop and show the error.

### 7. Output

Return:

```text
Context: <path>
Status: complete
Use: reference for /skill:research, /skill:debug, /skill:review, /skill:implement
```

When another skill receives a linked or named context report, it should read the
report before proposing changes, diagnosing failures, reviewing code, or
implementing plans.

## Rules

- Keep workflow state in blueprints, not chat or harness-native task stores.
- Keep source inspection targeted to the requested scope and direct context.
- Prefer source-linked claims over broad summaries.
- Separate descriptive context from proposals, fixes, reviews, and
  implementation plans.
- Preserve user changes; report dirty state instead of reverting it.