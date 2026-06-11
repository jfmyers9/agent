---
name: review
description: >
  Senior engineer code review, filing findings in review blueprints.
  Triggers: 'review code', 'code review', 'review my changes'.
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "[--local] [file-pattern] [<branch|PR>] | --continue [slug]"
---

# Review

Review introduced code and write findings to a `review/` blueprint.
Blueprints are the only review tracker.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Arguments

- `<file-pattern>` — optional changed-file filter
- `<branch|PR>` — optional branch or PR number
- `--local` — review staged/unstaged local changes instead of a branch
- `--continue [slug]` — continue latest or matching review blueprint

## Workflow

### 1. Resolve Target

- Numeric arg: resolve branch with
  `gh pr view <N> --json headRefName -q .headRefName`, then review
  that branch.
- Branch arg: checkout only if explicitly requested.
- `--local`: review staged/unstaged local changes.
- Empty: review current branch. If current branch is `main`/`master`
  and local staged/unstaged changes exist, review those local changes.
  If no local changes exist on `main`/`master`, stop unless files were
  explicitly supplied.

Set:

```bash
branch=$(git branch --show-current)
trunk=$(gt trunk 2>/dev/null || echo main)
review_target=branch
if [ "$branch" = "main" ] || [ "$branch" = "master" ] || [ "${LOCAL_CHANGES:-0}" = 1 ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    review_target=local
  fi
fi
```

### 2. Gather Context

Run targeted commands:

```bash
if [ "$review_target" = local ]; then
  git diff --name-only
  git diff --cached --name-only
  git diff
  git diff --cached
else
  git log --oneline "$trunk"..HEAD
  git diff "$trunk"...HEAD --name-only
  git diff "$trunk"...HEAD
fi
gh pr view --json title,body,labels,reviewDecision 2>/dev/null || true
```

For local-change reviews, treat unstaged and staged diffs as introduced code.
If a file has both staged and unstaged hunks, review both and identify
which finding comes from which diff only when that distinction matters.
Untracked files are reviewed only when explicitly named by file-pattern.

Apply file-pattern filters if provided. Exclude lock files, generated
artifacts, `dist/`, `build/`, `coverage/`, and binaries unless they are
the focus.

Large diffs: for files with >200 diff lines, keep first 50 and last 50
lines in prompt context, then read full files only when needed.

Keep reviews biased toward smaller, safer PRs. Defer speculative additions,
future-proofing, or broad refactors unless they fix a concrete issue
introduced by this change.


### 3. Detect Context

Language reviewer:

- `.go` -> go
- `.ts` / `.tsx` -> typescript
- `.py` -> python
- `.rs` -> rust

Plan coherence:

```bash
branch_slug=$(blueprint slug "$branch")
if [ "$review_target" != local ]; then
  plan_file=$(blueprint find --type spec,plan --match "$branch_slug")
fi
```

If found, read `## Spec` and compare the diff against it.

### 4. Review Perspectives

Run each perspective sequentially in this session:

- Architect
- Code Quality
- Devil's Advocate
- Operations
- Test Quality
- Language-specific reviewer, if detected
- Design Coherence, if a source spec exists

Perspective prompts live in `skills/review/perspectives/*.md`. Read each
prompt and apply it to the gathered raw diff/context. If prompt files are
unavailable, use the perspective names above as lenses.

For every potential finding, verify against source before keeping it:

1. Read `file:line` ± 20 lines.
2. Check whether the issue is handled nearby or by callers/callees.
3. Check whether it is introduced by this branch.
4. For async/concurrent/state-machine findings, trace the full path.

Remove false positives aggressively. Keep uncertain items only with
`[needs-review]`. Classify valid but non-blocking simplifications or future
work as deferred instead of actionable findings.

### 5. Aggregate Findings

Build one unified findings document:

```markdown
## Summary

- Assessment: Sound | Minor Concerns | Significant Concerns | Alternative Recommended
- Perspectives: <list>
- Findings: <actionable count>
- Deferred: <deferred count>
- Verification: verified <N>, pruned <M> false positives, downgraded <K>

## Reviewer Summaries

- Architect: ...
- Code Quality: ...
- Devil's Advocate: ...
- Operations: ...
- Test Quality: ...

## Findings

### <short title>

- Severity: critical | medium | low
- File: `<path:line>` or `cross-file`
- Confidence: source reading | execution verified | production/tool data | inferred
- Verification: <what was checked>
- Perspectives: <which lenses found it>

<why this is an introduced, actionable issue and what should change>

## Deferred Findings

### [defer] <short title>

- Severity: low | medium
- File: `<path:line>` or `cross-file`
- Confidence: <label>
- Verification: <what was checked>

<valid observation that should not block this PR>

## What I verified

- <source checks, caller/callee checks, tests, or commands reviewed>

## Considered and dismissed

- <false positive or pre-existing issue and why it was removed>

## Reply Notes

<optional notes for PR responses>
```

Skip empty sections. Group duplicate findings by root cause. Put consensus or
critical actionable findings first within `## Findings`. `Deferred Findings`
are body-only recommendations, not fix requirements.



### 6. Store Review Blueprint

```bash
if [ "$review_target" = local ]; then
  file=$(blueprint create review "Review: local changes" --status draft --branch "$branch")
else
  file=$(blueprint create review "Review: $branch" --status draft --branch "$branch")
fi
```

If a source plan/spec was found:

```bash
SOURCE_SLUG=$(basename "$plan_file" .md)
blueprint link "$file" "$SOURCE_SLUG"
```

Write the findings body, then:

```bash
blueprint commit review <slug>
```

If commit fails, stop and show the error.

### 7. Report

```text
Review: <path>
Assessment: <rating>
Findings: <actionable/deferred counts>
Next: /skill:fix for actionable findings, /skill:simplify for deferred design cleanup, or /skill:commit if clean
```

## Rules

- Review introduced code first.
- Only flag pre-existing code when it is critical and newly relevant.
- Always verify findings against source before output.
- Do not create native task state.
- Do not spawn subagents or teams.
