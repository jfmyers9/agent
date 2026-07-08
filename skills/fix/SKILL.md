---
name: fix
description: >
  Revalidate and resolve supplied review findings or other concrete feedback.
  Use when the user asks to fix already identified issues. Use respond instead
  for active pull-request threads, reply drafting, or posting decisions.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[feedback-text|review-slug-or-path]"
---

# Fix

Resolve evidence-backed feedback while preserving unrelated work.

@rules/blueprints.md and @rules/harness-compat.md apply.

## Workflow

### 1. Resolve Feedback

- Explicit feedback: use it directly.
- Review path or slug: resolve one unambiguous file with
  `blueprint find --type review --match <slug>`, then store its path in `file`
  and derive its artifact slug for later updates.
- No argument: use a clearly relevant recent review when one exists. Ask for
  the intended feedback when none exists or multiple reviews are plausible.

Do not create a fix plan. Existing proposals or legacy plans may be context,
not required trackers.

### 2. Revalidate

Inspect repository instructions and the working tree before editing. For each
finding, read the cited code plus relevant callers and tests, then classify it
with evidence:

- `valid` — current code exhibits the issue;
- `already resolved` — current code contains the required correction;
- `not reproducible` — the claimed behavior cannot be established; or
- `declined` — the user or documented project constraints reject an otherwise
  valid change.

Implement only valid unresolved findings. Preserve unrelated user changes.

### 3. Implement And Verify

For each valid finding, make the smallest complete correction. Add or update a
focused regression test when it protects the reported behavior. Run the
narrowest relevant check first, then broader checks warranted by shared code or
risk. Re-read the resulting diff against the original finding.

### 4. Record Review Resolutions

When feedback came from a review, update that same file:

```markdown
## Resolutions

| Finding | Outcome | Change | Verification |
| ------- | ------- | ------ | ------------ |
| F001 | fixed | `<path>` — summary | `<command>` — pass |
```

Use the review's stable finding IDs. Outcomes are `fixed`, `already resolved`,
`not reproducible`, or `declined`. Preserve existing resolution rows and update
the same review rather than creating another artifact. Preserve its
frontmatter and write below the closing `---`. Immediately before committing,
run `blueprint validate "$file"` and inspect the entire blueprint repository.
Stop if its index is nonempty or the current project has changes outside
`$file`: `blueprint commit` stages the project subtree and commits the existing
index. Then run `blueprint commit review <slug>` and stop on any error.

### 5. Report

Return each finding's outcome, files changed, commands and results, and any
remaining risk. No new blueprint is created.
