---
name: context
description: >
  Create a durable, evidence-backed map of a codebase area. Invoke only as
  /skill:context or $context when a persistent context report is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: >
  <scope> [--depth <level>] [--for <audience>] [--continue]
  [--update <slug>] [--link <slug>]
---

# Context

Map a bounded codebase area and store reusable evidence in a report blueprint.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.
Immediately before committing, run `blueprint validate "$file"` and inspect the
entire blueprint repository. Stop if its index is nonempty or the current
project has changes outside `$file`: `blueprint commit` stages the project
subtree and commits the existing index.

## Arguments

- `<scope>` — repository, subsystem, feature, path, symbol, or file set to map.
- `--depth <quick|medium|high|max>` — inspection depth; default `medium`.
- `--for <general|research|debug|implement|review>` — audience for handoff
  notes; default `general`.
- `--continue` — finish the latest context report.
- `--update <slug>` — refresh a matching context report in place.
- `--link <slug>` — link the report to a source blueprint.

Depth controls breadth:

- `quick` — entrypoints, primary modules, and immediate verification commands.
- `medium` — main runtime/data flows, state, interfaces, and tests.
- `high` — relevant callers, callees, failure paths, and hidden invariants.
- `max` — reachable boundaries and edge cases within the declared scope.

## Workflow

### 1. Resolve The Report And Source

- Treat `--continue` and `--update` as mutually exclusive. For `--continue`,
  identify the latest report whose topic or body marks it as a context report.
  Do not assume the latest generic report is context. Store its path in `file`.
- For `--update <slug>`, resolve it with
  `blueprint find --type report --match <slug>` and confirm that it is a
  context report. Store the unambiguous resolved path in `file`.
- Continue and update the same file; do not create a replacement. Preserve
  still-valid durable notes, refresh snapshot metadata, and mark stale claims.
- For `--link <slug>`, resolve one unambiguous `source_file` with
  `blueprint find --type proposal,review,report,spec,plan --match <slug>`.
- For new work, derive the scope from the request. If no scope is given,
  inspect the repository root, README, project metadata, and top-level tree,
  then use a repository-wide scope.

### 2. Bound The Inspection

Record included paths, symbols, and behaviors plus explicit exclusions. Ignore
generated, vendored, build, coverage, lockfile, and binary artifacts unless
they are in scope.

- Path scope: inspect those paths plus only the direct callers, callees, tests,
  configuration, and documentation needed to explain them.
- Feature or symbol scope: find definitions and references first, then read
  only the files needed to trace material flows.
- Repository scope: inventory top-level ownership boundaries before selecting
  representative entrypoints and flows.

Prefer symbol-aware tools when available. Keep searches and command output
bounded. Preserve user changes and record relevant dirty state; do not modify
the working tree.

### 3. Collect And Verify The Map

Capture concise evidence for:

- branch, commit, dirty state, and observation date
- entrypoints and ownership boundaries
- major modules, types, schemas, stores, caches, and configuration
- external CLI, API, UI, event, file, network, and database interfaces
- tests, probes, and useful verification commands
- local patterns, invariants, risks, and unresolved questions

For each material behavior, trace the entrypoint, orchestration, state or data
transformation, side effects, output boundary, and relevant test. Cite paths
and line numbers for claims future work may rely on.

Verify all material architecture claims against source; verify at least three
when the report contains that many. Label verification with the evidence terms
from `@rules/artifact-readability.md`, and state confidence separately. Add a
small Mermaid map and trace table for non-trivial architecture or flow;
otherwise state why a diagram is unnecessary.

### 4. Write The Context Report

After inspection, create new reports as complete:

```bash
file=$(blueprint create report "Context: <scope>" --status complete)
```

For continue/update, edit the resolved report. Link a requested source to the
new or existing report with:

```bash
source_slug=$(basename "$source_file" .md)
blueprint link "$file" "$source_slug"
```

Write or update this structure:

```markdown
## Executive Summary

<concise bullets explaining what the area does and how to reason about it>

## Scope

<included boundaries, exclusions, depth, and intended audience>

## Snapshot

- Branch: <branch>
- Commit: <sha>
- Dirty state: <clean or relevant paths>
- Observed: <timestamp>
- Entry paths: <paths>

## Human-Readable Map

### System Map

<Mermaid flowchart or `Diagram omitted: <reason>`>

### Main Modules

- `<path>` — responsibility, ownership, and key exports

### Request / Data Flow

<Mermaid sequence diagram or `Diagram omitted: <reason>`>

### Flow Trace

| Step | Code / Config | Responsibility | Evidence |
| ---- | ------------- | -------------- | -------- |

### Data Model / State

- <important types, schemas, stores, caches, and configuration>

### External Interfaces

- <CLI, API, UI, events, files, network, database>

## Evidence Summary

| Claim | Evidence | Verification | Confidence |
| ----- | -------- | ------------ | ---------- |

## Important Code Paths

- `<path:line>` — why it matters

## Patterns To Preserve

- <local conventions, boundaries, error handling, and test style>

## Risks / Sharp Edges

- <coupling, invariants, global state, migrations, or expensive checks>

## Verification / Useful Commands

```bash
<commands>
```

## Open Questions

- <unknown, why it matters, and how to answer it>

## Handoff Notes

<notes tuned to --for: constraints for research; fault domains for debug;
touchpoints for implement; regression surfaces for review; reusable context for
general>

## Investigation Log

- Commands run:
- Tests/probes:
- External docs/tools:
- Gaps:
```

Keep the report descriptive. Even for `--for implement`, record touchpoints and
constraints rather than an implementation plan.

### 5. Commit And Report

Run `blueprint commit report <slug>` after writing the body. On an existing
report, commit each link, body, or other frontmatter update before making the
next one. For an existing draft, commit the body first, then set it to complete
and commit that status change separately:

```bash
blueprint status "$file" complete
blueprint commit report <slug>
```

Stop and show any commit error. Return:

```text
Context: <path>
Status: complete
Use: reference for $research, $debug, $review, or $implement
```
