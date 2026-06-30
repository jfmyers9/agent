---
name: review
description: >
  Create a durable code review artifact for introduced changes. Invoke only as
  /skill:review or $review when a persistent review is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "[--local] [file-pattern] [branch|PR] [--proposal <slug-or-path>]"
---

# Review

Review introduced code and store verified findings in one complete artifact.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Workflow

### 1. Resolve Target

- PR number: resolve its head branch.
- Branch: review its merge-base diff; checkout only when explicitly requested.
- `--local`: review staged and unstaged changes.
- Empty: current branch, or local changes on trunk.
- `--proposal`: read that proposal for conditional coherence review.

Untracked files are included only when explicitly named. Exclude generated
files, lock files, build output, coverage, and binaries unless they are the
focus.

### 2. Gather Context

Collect bounded changed-file lists, diffs, commits, and optional PR metadata.
For large diffs, summarize first and read complete files only around candidate
findings. If no proposal was supplied, a clearly branch-matching proposal may
be discovered with `blueprint find --type proposal,spec,plan --match <slug>`;
absence is normal.

### 3. Apply Lenses

Read the concise checklists in `skills/review/perspectives/` and apply:

Core:

- correctness and compatibility, including language/framework idioms
- design and maintainability
- tests

Conditional:

- security and operations when trust, persistence, concurrency, deployment, or
  production failure boundaries changed
- proposal coherence when a relevant proposal or legacy design exists

For every candidate: inspect the cited line and nearby code; trace callers,
callees, state, or async paths as needed; confirm it is introduced; prune false
positives. Defer valid non-blocking cleanup instead of inflating findings.

### 4. Write Findings

Assign stable sequential IDs (`F001`, `F002`, ...). Never renumber existing IDs
when updating a review.

```markdown
## Summary

- Assessment: Sound | Minor Concerns | Significant Concerns
- Lenses: <applied lenses>
- Findings: <count>
- Deferred: <count>

## Findings

### F001: <short title>

- Severity: critical | medium | low
- File: `<path:line>` or `cross-file`
- Confidence: source reading | execution verified | production/tool data | inferred
- Lenses: <names>
- Verification: <what was checked>

<introduced problem, impact, and specific correction>

## Deferred Findings

### D001: <short title>

<non-blocking observation>

## Resolutions

| Finding | Outcome | Change | Verification |
| ------- | ------- | ------ | ------------ |

## What I Verified

- <checks>

## Considered And Dismissed

- <candidate and why pruned>
```

Omit empty deferred/dismissed sections, but retain the empty resolution table
when actionable findings exist.

### 5. Store Complete Review

```bash
file=$(blueprint create review "Review: <target>" --status complete --branch "$branch")
```

Link a source proposal when used. Write once, then
`blueprint commit review <slug>`. Reviews are complete when generated; finding
resolution state lives in `## Resolutions`.

### 6. Report

Return path, assessment, counts, and `$fix <review>` or `$commit` as the next
action.

## Rules

- Review introduced code first; mention pre-existing code only when newly
  activated or critical to the change.
- Findings require source verification and a concrete impact.
- Do not create native task state or spawn reviewers.
