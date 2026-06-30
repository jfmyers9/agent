---
name: acceptance
description: >
  Create a durable acceptance review against named criteria. Invoke only as
  /skill:acceptance or $acceptance when a persistent verdict is wanted.
disable-model-invocation: true
user-invocable: true
argument-hint: "<proposal-or-path>"
allowed-tools: [Bash, Read, Glob, Grep, Write]
---

# Acceptance

Verify implementation criteria and store a complete review artifact.

@rules/blueprints.md and @rules/harness-compat.md apply.

## Workflow

### 1. Resolve Criteria

Read an explicit path or resolve:

```bash
blueprint find --type proposal,review,spec,plan --match <slug>
```

Prefer `## Acceptance Criteria`, then legacy done signals/findings. If criteria
remain unclear, ask what to verify.

### 2. Gather And Verify

Inspect branch/local changes and run two focused lenses:

- Verifier: mark every criterion `PASS`, `PARTIAL`, `FAIL`, or `N/A` with
  file/line and execution evidence.
- Breaker: test implied requirements, edge cases, integration risk, negative
  behavior, and technically-complete but unusable outcomes.

Verdict is `FAIL` for any failure, `PARTIAL` for partial criteria or a high
breaker finding, otherwise `PASS`.

### 3. Store Review

```bash
file=$(blueprint create review "Acceptance: <target>" --status complete)
blueprint link "$file" "<source-slug>"
```

Write:

```markdown
## Acceptance Verdict

PASS | PARTIAL | FAIL

## Criteria Matrix

| Criterion | Result | Breaker flags | Evidence |
| --------- | ------ | ------------- | -------- |

## Findings

### F001: <title>

<actionable gap>

## Resolutions

| Finding | Outcome | Change | Verification |
| ------- | ------- | ------ | ------------ |
```

Use stable sequential finding IDs. Commit with
`blueprint commit review <slug>`.

### 4. Report

Return artifact path, verdict, and findings. Suggest `$fix <review>` for gaps or
`$commit` for a pass. Do not automatically create or execute a fix plan.
