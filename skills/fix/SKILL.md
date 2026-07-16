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
  `blueprint find --type review --match <slug>`, then store its path in `file`.
- No argument: use concrete feedback already supplied in the current
  conversation. Otherwise ask for the intended feedback; do not discover or
  mutate a recent review implicitly.

Do not create a fix plan. Existing proposals or legacy plans may be context,
not required trackers.

When the source review says `NO-GO / replace`, do not patch around a misguided
approach. Stop and request explicit replacement instructions. Ignore all
deferred `D` observations; they are outside the review closure loop.

### 2. Revalidate

Inspect repository instructions and the working tree before editing. For a
source review, require the current repository and branch to match its recorded
target and require the reviewed commit to be in its history. Do not switch
branches or edit an unrelated worktree implicitly. Before editing, apply the
review's basis-drift check: the recorded base must be unchanged and every
current difference from the reviewed or last-verified snapshot must already map
to an existing resolution row. Stop for a fresh review on any unmapped drift.

Process only unresolved `F` IDs and preserve every row already marked
`verified`. For each unresolved finding, read the cited code plus relevant
callers and tests, then classify it with evidence:

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

| Finding | Resolution | Verification | Change / Evidence |
| ------- | ---------- | ------------ | ----------------- |
| F001 | fixed | pending | `<path>` — summary; `<command>` — pass |
```

Use the review's stable `F` IDs. Resolutions are `fixed`, `already resolved`,
`not reproducible`, or `declined`. Use `pending` verification for the first
three and `unresolved` for `declined`; only `$review --verify <review>` may mark
a resolution `verified` or `failed` and change the review decision to `GO`.
For each code change, record every affected path and hunk or line range so the
verification pass can reject edits unrelated to that finding.

Preserve existing rows and migrate an older outcome table without losing its
evidence. Do not remove findings or change their IDs. Update the same review
rather than creating another artifact. Preserve its frontmatter and write below
the closing `---`. Immediately before committing, run
`blueprint validate "$file"`, then `blueprint commit review "$file"`. The CLI
refuses a pre-existing blueprint index and stages only that review. Stop on any
error.

### 5. Report

Return each finding's resolution, files changed, commands and results, and any
remaining risk. For a review with a persisted basis, direct the user to
`$review --verify <review>`; a legacy review requires a fresh review. No new
blueprint is created.
