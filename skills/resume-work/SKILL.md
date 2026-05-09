---
name: resume-work
description: >
  Resume work on a branch/PR after a break. Use when asking where was
  I, what's the status, picking up where I left off, what needs
  attention, or getting context on current work. Triggers:
  /resume-work, /resume.
allowed-tools: Bash, Read, Glob
argument-hint: "[branch-name|PR#]"
---

# Resume Work

Gather branch, PR, CI, review, and blueprint state. Recommend the next
action.

@rules/blueprints.md and @rules/harness-compat.md apply.

## Arguments

- `<branch-name>` — checkout and resume branch
- `<PR#>` — resolve branch from PR number
- no args — use current branch

## Steps

### 1. Resolve Branch

- Empty → current branch
- Numeric → `gh pr view <N> --json headRefName -q .headRefName`, then
  checkout
- Otherwise → checkout provided branch

Exit if branch cannot be resolved.

### 2. Gather Context

Run concise commands:

```bash
git branch --show-current
git log --oneline -10
git status -sb
gh pr view --json number,title,state,isDraft,reviewDecision,statusCheckRollup,url 2>/dev/null || true
gh pr checks 2>/dev/null || true
blueprint find --type spec,plan,review,report
blueprint find --type archive
project=$(blueprint project)
cd ~/workspace/blueprints && git status --porcelain "$project/" 2>/dev/null || true
```

Fetch unresolved PR comments when a PR exists, limiting output with
`head -20`.

### 3. Summarize

```text
Branch: <branch>
Commits: <last 3>
PR: <number/state/title/url or none>
Review: <decision + unresolved count>
CI: <passing/failing + key failures>
Blueprints: <pending specs/plans/reviews>
Archived: <relevant archived blueprints>
Blueprint repo: <clean/dirty>
Working tree: <clean/dirty>
```

### 4. Suggest Next Action

Pick first match:

1. CI failing → fix checks with `/skill:debug`
2. Changes requested/unresolved comments → `/skill:respond` or
   `/skill:pr-plan`
3. Pending `spec_review`/`plan_review` blueprint → `/skill:research --continue`
4. Pending approved plan/spec/review → `/skill:implement`
5. Dirty working tree with completed work → `/skill:review` or
   `/skill:commit`
6. Draft PR, all passing → mark ready
7. Ready PR, approved → merge or submit stack
8. No PR → `/skill:submit`
9. All clear → wait for review or start next blueprint

## Notes

- Keep output short.
- Prefer blueprint state over chat history.
- Mention uncommitted blueprint changes if present.
