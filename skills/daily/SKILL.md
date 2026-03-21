---
name: daily
description: >
  Summarize repo activity — your PRs, review requests, assigned
  issues, and recent trunk commits. Triggers: 'daily summary',
  'what's happening', 'repo status'.
allowed-tools: Bash, Read, Glob
argument-hint: "[path...]"
---

# Daily

Print a summary of what needs attention in the current repo.

## Arguments

- `[path...]` — optional path patterns to filter PRs and commits

## Steps

### 1. Resolve Trunk

Parse `$ARGUMENTS` for path patterns (store as `$PATHS`).

Detect the trunk branch:

```bash
trunk=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
  | sed 's|refs/remotes/origin/||')
```

If empty, try `main` then `master` — check which exists with
`git rev-parse --verify origin/main` (then `origin/master`).

Fetch latest: `git fetch origin $trunk --quiet`

### 2. Gather Context

Run in parallel (all four Bash calls in one message):

```bash
# Your open PRs
gh pr list --author @me \
  --json number,title,isDraft,reviewDecision,statusCheckRollup,url,updatedAt,headRefName \
  2>/dev/null | head -20 || echo "[]"
```

```bash
# PRs requesting your review
gh pr list --search "review-requested:@me" \
  --json number,title,url,updatedAt,headRefName,author \
  2>/dev/null | head -20 || echo "[]"
```

```bash
# Assigned issues
gh issue list --assignee @me \
  --json number,title,labels,url,updatedAt \
  2>/dev/null | head -20 || echo "[]"
```

```bash
# Recent trunk commits (path-filtered if $PATHS set)
git log origin/$trunk --oneline --since="24 hours ago" \
  -- $PATHS 2>/dev/null | head -20 || echo ""
```

### 3. Path Filtering (conditional)

Skip if `$ARGUMENTS` is empty (no path patterns provided).

If path patterns were provided:
- For each PR from step 2, fetch changed files:
  `gh pr view <N> --json files --jq '.files[].path'`
- Exclude PRs where no changed file matches any pattern
  from `$PATHS`
- Retain excluded PRs in a separate count for reporting:
  "(N more PRs outside filtered paths)"

### 4. Format and Print

Print the summary directly to the user. Use today's date.

#### Output template

```
## Daily Summary — <YYYY-MM-DD>

### Your Open PRs (<count>)
- #N (draft|ready) title — CI: passing|failing|pending, Review: approved|changes requested|pending|none
(or "None" if no open PRs)

### Review Requests (<count>)
- #N @author title — waiting since <relative date>
(or "None" if no review requests)

### Assigned Issues (<count>)
- #N title [label1, label2]
(or "None" if no assigned issues)

### Recent Activity on <trunk> (last 24h)
- <hash> <subject>
(or "No recent commits")

### Needs Attention
- Review #N from @author (requested <N days> ago)
- Fix CI on #N (failing)
- Respond to review on #N (changes requested)
```

#### Needs Attention heuristics

Populate from gathered data, in this priority order:

1. PRs requesting your review — oldest first
2. Your PRs with failing CI (`statusCheckRollup` contains
   failures)
3. Your PRs with `reviewDecision == "CHANGES_REQUESTED"`

Omit the Needs Attention section entirely if no items match
the heuristics — do not print "Nothing urgent".

#### Formatting rules

- Truncate each section at 10 items. If more exist, append
  "(+N more)" after the last item.
- If path filtering was applied in step 3, append
  "(N more PRs outside filtered paths)" after the relevant
  PR sections.
