---
name: fix
description: >
  Revalidate and resolve supplied feedback or findings from an existing review.
  Use when the user asks to fix identified issues.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[feedback-text|review-slug-or-path]"
---

# Fix

Revalidate feedback, implement valid fixes, verify them, and record resolutions.

@rules/blueprints.md and @rules/harness-compat.md apply.

## Workflow

### 1. Resolve Feedback

- Explicit text: use it directly.
- Review path/slug: read it; resolve slugs with
  `blueprint find --type review --match <slug>`.
- No args: use the most relevant recent review if one exists; otherwise ask for
  feedback.

Do not create a fix plan. Existing proposals or legacy plans may be context,
not required trackers.

### 2. Revalidate

For each finding, read the cited code and nearby callers/tests. Mark it
`valid`, `already resolved`, `not reproducible`, or `declined`, with evidence.
Only valid unresolved findings enter implementation.

### 3. Implement And Verify

Reuse the implement loop: smallest complete change, focused test first, broader
checks when warranted. Preserve unrelated changes.

### 4. Record Review Resolutions

When feedback came from a review, update that same file:

```markdown
## Resolutions

| Finding | Outcome | Change | Verification |
| ------- | ------- | ------ | ------------ |
| F001 | fixed | `<path>` — summary | `<command>` — pass |
```

Use the review's stable finding IDs. Outcomes: `fixed`, `already resolved`,
`not reproducible`, or `declined`. Commit with
`blueprint commit review <slug>`.

### 5. Report

Return outcomes, files changed, and verification. No new blueprint is created.
