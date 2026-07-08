---
name: review
description: >
  Create a durable code review of introduced branch, PR, or local changes.
  Invoke only as /skill:review or $review when persistent verified findings are
  wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "[--local] [file-pattern] [branch|PR] [--proposal <slug-or-path>]"
---

# Review

Review introduced code and store verified findings in one complete review
blueprint.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.
Immediately before committing, run `blueprint validate "$file"` and inspect the
entire blueprint repository. Stop if its index is nonempty or the current
project has changes outside `$file`: `blueprint commit` stages the project
subtree and commits the existing index.

## Arguments

- `--local` — review staged and unstaged changes.
- `[file-pattern]` — restrict review to matching changed files.
- `[branch|PR]` — review a branch diff or pull request.
- `--proposal <slug-or-path>` — compare the implementation with a named source
  decision and its acceptance criteria.

## Workflow

### 1. Resolve The Target

- PR number: resolve its head and base without checking it out.
- Branch: review its merge-base diff against its PR base or Graphite parent,
  falling back to trunk. Check it out only when explicitly asked.
- `--local`: review staged and unstaged changes.
- No target: review the current branch, or local changes when on trunk.
- File pattern: apply it after resolving the change set.

Include untracked files only when explicitly named. Exclude generated files,
build output, coverage, binaries, and routine lockfile churn unless they are
material to the change.

### 2. Gather Bounded Context

Collect changed-file lists, diffs, commits, and relevant PR metadata. For a
large diff, summarize it first, then read complete code only around candidate
findings and the call paths needed to verify them.

Store an explicitly supplied proposal path in `source_file`, or resolve an
explicit proposal slug to one unambiguous `source_file`, then read it.
Otherwise, derive a branch/PR slug with `blueprint slug`, then use
`blueprint find --type proposal,spec,plan --match <slug>` only when the result
clearly matches the change; store that result in `source_file`. Absence is
normal.

### 3. Apply Review Lenses

Read the checklists in `skills/review/perspectives/` and apply:

- **Core:** correctness and compatibility, design and maintainability, tests.
- **Conditional:** security and operations when trust, persistence,
  concurrency, deployment, resources, or production failure boundaries
  changed; proposal coherence when a relevant design exists.

Independent lenses may run in parallel when the harness supports it. The
workflow must not depend on subagents or harness-native task state, and the
primary reviewer must reconcile overlapping or conflicting candidates.

For every candidate, inspect the cited line and nearby code; trace callers,
callees, state, and asynchronous paths as needed; confirm the issue is
introduced by the target; and prune false positives. Keep an actionable
finding only when source or execution evidence establishes concrete impact.
Put valid but non-blocking cleanup under deferred findings. For findings that
depend on a multi-boundary flow, include the map, trace, and evidence
cross-reference required by `@rules/artifact-readability.md`.

### 4. Classify And Write Findings

Assign stable sequential IDs (`F001`, `F002`, ...); never renumber them when a
review is updated. Use `D001`, `D002`, ... for deferred observations.

Set the assessment to `Significant Concerns` for critical/high findings,
`Minor Concerns` for only medium/low findings, and `Sound` when no actionable
findings remain.

Use `critical` for catastrophic security, data, or availability impact; `high`
for broken core behavior or a likely severe failure; `medium` for a bounded
real defect; and `low` for a small but concrete correctness or maintenance
risk.

```markdown
## Summary

- Assessment: Sound | Minor Concerns | Significant Concerns
- Target: <branch, PR, local diff, and optional file scope>
- Lenses: <applied lenses>
- Findings: <count>
- Deferred: <count>

## Human-Readable Map

<diagram, trace, and cross-reference for a multi-boundary finding, or
`Diagram omitted: <reason>`>

## Findings

### F001: <short title>

- Severity: critical | high | medium | low
- Location: `<path:line>` or `cross-file`
- Lenses: <names>
- Verification: source reading | execution verified | production/tool data
- Confidence: High | Medium | Low
- Evidence: <what was inspected or run>

<introduced problem, concrete impact, and smallest safe correction>

## Deferred Findings

### D001: <short title>

- Location: `<path:line>` or `cross-file`
- Reason deferred: <why it is valid but non-blocking>

<scoped observation>

## Resolutions

| Finding | Outcome | Change | Verification |
| ------- | ------- | ------ | ------------ |

## What I Verified

- <check and result>

## Considered And Dismissed

- <candidate and why it was pruned>
```

Omit empty deferred and dismissed sections. Retain the empty resolution table
when actionable findings exist.

### 5. Store The Complete Review

```bash
file=$(blueprint create review "Review: <target>" --status complete --branch "$branch")
```

Omit `--branch` when no branch applies. Link a source only when it is a
blueprint; cite a plain path only in the body:

```bash
source_slug=$(basename "$source_file" .md)
blueprint link "$file" "$source_slug"
```

Write the complete body, then run `blueprint commit review <slug>`. Stop and
show any commit error. Reviews are complete when generated; later finding
outcomes belong in `## Resolutions`.

### 6. Report

Return the artifact path, assessment, counts, and finding IDs. Suggest
`$fix <review>` when findings exist or `$commit` when the review is sound.

## Rules

- Review introduced behavior first. Mention pre-existing code only when the
  change newly activates it or it creates critical context.
- Do not modify the reviewed source or its remote state. The review blueprint
  and its required commit are the only intended writes.
- Omit style preferences and speculative cleanup without concrete impact.
  Defer only evidenced, non-blocking issues.
