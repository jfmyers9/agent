---
name: resume-work
description: >
  Resume work on a branch/PR after a break. Use when asking where was I, what's the status, picking up
  where I left off, what needs attention, or getting context on current work. Triggers: /resume-work, /resume
allowed-tools: Bash, Read, Glob, TaskList, TaskGet
argument-hint: "[branch-name|PR#]"
---

# Resume Work

Gather context on current work and suggest next action.

## Arguments

- `<branch-name>` — checkout and resume specific branch
- `<PR#>` — resolve branch from PR number
- (no args) — use current branch

## Steps

### 1. Resolve Branch

Parse `$ARGUMENTS`:
- Empty → `git branch --show-current`
- Numeric → resolve via
  `gh pr view "$ARGUMENTS" --json headRefName -q .headRefName`,
  then checkout
- Otherwise → `git checkout "$ARGUMENTS"`

Exit if branch can't be resolved.

### 2. Gather Context

Run in parallel:

```bash
git branch --show-current
git log --oneline -10
git status -sb

gh pr view --json number,title,state,isDraft,reviewDecision,statusCheckRollup,url \
  2>/dev/null || echo "No PR"
gh pr checks 2>/dev/null || echo "No PR"
```

Fetch unresolved review comments (via GraphQL):

```bash
PR_NUM=$(gh pr view --json number -q .number 2>/dev/null)
if [[ -n "$PR_NUM" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  OWNER="${REPO%%/*}"
  REPO_NAME="${REPO##*/}"
  gh api graphql --paginate -F owner="$OWNER" -F repo="$REPO_NAME" -F pr="$PR_NUM" -f query='
    query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved
              isOutdated
              path
              line
              comments(first: 1) {
                nodes { body author { login } }
              }
            }
          }
        }
      }
    }' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[]
      | select(.isResolved == false)
      | "- \(.path):\(.line) (@\(.comments.nodes[0].author.login)): \(if .isOutdated then "[outdated] " else "" end)\(.comments.nodes[0].body | split("\n")[0])"' \
    2>/dev/null | head -20
fi
```

Fetch task, team, and plan state:

- `TaskList()` for in_progress/pending tasks
- Read `~/.claude/teams/*/config.json` for active teams
- Determine `<project>`: `basename $(git rev-parse --show-toplevel 2>/dev/null || pwd)`
- `ls -t ~/workspace/blueprints/<project>/*.md 2>/dev/null | head -5`
  for pending plan files
- `ls -t ~/workspace/blueprints/<project>/archive/*.md 2>/dev/null | head -5`
  for archived (previously prepared) plans

### 3. Summarize

Format gathered data as:

```
**Branch:** `branch-name`
**Commits:** Last 3 commit messages
**PR:** #123 (draft/ready) - title
**Review:** Approved | Changes requested | Pending
**CI:** Passing | Failing (list failures)
**Comments:** N unresolved (summarize key ones)
**Plans:** N pending plan files (list filenames)
**Archived Plans:** N archived plans (list filenames)
**Tasks:** N in progress, M pending, K active teams
```

### 4. Suggest Next Action

Pick the first matching condition:

1. **CI failing** → "Fix failing checks: [check names]"
2. **Changes requested** → "`/respond` to triage N comments"
3. **Unresolved comments** → "`/respond` to triage feedback"
4. **Pending plan files** → "`/implement` to create tasks from
   [filename], or edit in `$EDITOR` first"
5. **Tasks in progress** → "Continue: [task subject]"
6. **Active team** → "`/implement` to continue team work"
7. **Draft PR, all passing** → "Mark PR ready for review"
8. **Ready PR, approved** → "Merge PR"
9. **No PR** → "`/submit` to create PR"
10. **All clear** → "`/review` or wait for review"

## Notes

- Limit output with `head -N` to prevent context overflow
- Only unresolved review threads (filtered via GraphQL `isResolved`)
