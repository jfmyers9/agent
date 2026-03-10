---
name: pr-plan
description: >
  Fetch PR review comments, triage, and research a plan to
  address them. Triggers: /pr-plan, "plan for PR comments",
  "address PR feedback".
allowed-tools: Bash, Read, Write, Task, TaskCreate, TaskUpdate, TaskGet, TaskList
argument-hint: "[pr-number] | <task-id> | --continue"
---

# PR Plan

Fetch PR comments, triage validity, research fixes, produce
a `/prepare`-compatible plan.

## Arguments

- `<pr-number>` — target a specific PR
- `<task-id>` — continue existing pr-plan task
- `--continue` — resume most recent in_progress pr-plan task
- (no args) — use current branch's PR

## Plan Directory

`<project>` = `basename` of git root (or cwd if not in a repo).
Determine via:
`basename $(git rev-parse --show-toplevel 2>/dev/null || pwd)`

Plans live at `~/.claude/plans/<project>/pr-plan-<number>.md`.
Create on first write: `mkdir -p ~/.claude/plans/<project>/`

## Workflow

### New Session

1. **Get PR context**
   - If PR number provided:
     `gh pr view <number> --json number,title,url`
   - Else: `gh pr view --json number,title,url` (current branch)
   - Exit if no PR found — suggest `/submit` first

2. **Fetch comments** (all parallel)
   ```bash
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   PR_NUM=<number>

   # Inline review comments
   gh api "repos/$REPO/pulls/$PR_NUM/comments" \
     --jq '.[] | {id, path, line, original_line, body,
       user: .user.login, in_reply_to_id, created_at,
       diff_hunk, subject_type}'

   # Top-level reviews + decision
   gh pr view $PR_NUM --json reviews,comments,reviewDecision

   # Current diff
   git diff main...HEAD

   # Commit history
   git log main..HEAD --format="%h %s"
   ```

3. **Filter comments**
   - Only top-level (`in_reply_to_id == null`)
   - Exclude bots (dependabot, github-actions, etc.)
   - Exclude PR author's own comments
   - Group by file path
   - If zero comments after filtering → report "No actionable
     comments" and exit

4. **Create task**
   ```
   TaskCreate(
     subject: "PR Plan: #<PR_NUM>",
     description: "Triage PR comments and research implementation
       plan. Findings → ~/.claude/plans/<project>/pr-plan-<N>.md",
     activeForm: "Planning PR #<PR_NUM> feedback",
     metadata: { type: "task", priority: 2 }
   )
   TaskUpdate(taskId, status: "in_progress")
   ```

5. **Spawn triage + plan subagent** (see Subagent Prompt)

   Single Task (subagent_type=Explore, model=opus). The agent
   both triages comments AND researches fixes for agreed items
   in one pass — no two-step handoff.

6. **Store findings**
   a. Parse subagent output into two sections:
      - `plan` — phased implementation steps (agreed items)
      - `replies` — draft replies (disagree/already-done/question)
   b. Write plan file with frontmatter:
      ```yaml
      ---
      topic: "PR #<number> feedback"
      project: <absolute path to cwd>
      created: <ISO 8601 timestamp>
      status: draft
      ---
      ```
      Followed by the full plan + replies sections.
   c. Store in task metadata:
      ```
      TaskUpdate(taskId, metadata: {
        design: "<plan section>",
        notes: "<replies section>",
        plan_file: "pr-plan-<number>.md"
      })
      ```

7. **Complete task**
   `TaskUpdate(taskId, status: "completed")`

8. **Report results** (see Output Format)

### Continue Session

1. Resolve task:
   - `$ARGUMENTS` matches task ID → `TaskGet(taskId)`
   - `--continue` → `TaskList()`, find first in_progress task
     with subject starting "PR Plan:"
2. Load context: `TaskGet(taskId)` → `metadata.design`
3. Spawn Explore agent with previous findings prepended:
   "Previous findings:\n<design>\n\nContinue..."
4. Update plan file and task metadata
5. Report results

## Subagent Prompt

Spawn Task (subagent_type=Explore, model=opus) with:

```
You are a senior engineer analyzing PR review feedback and
planning fixes. Two jobs: triage each comment, then research
the codebase to plan fixes for valid ones.

## PR
<pr-title> (#<pr-number>)

## Commits
<git log main..HEAD --format="%h %s">

## Reviewer Comments
<for each: author, file, line, body, diff_hunk>

## Full Diff
<git diff main...HEAD>

## Instructions

### Part 1: Triage

For EACH comment, read the actual code and classify:

- **agree** — valid, code should change
- **disagree** — incorrect or misguided
- **question** — ambiguous, need clarification
- **already-done** — already handled in code

### Part 2: Plan Fixes

For all "agree" items, research the codebase to understand:
- What needs to change and where
- Related code that might be affected
- The safest approach

Then write phased implementation steps.

## Output Structure

Return COMPLETE findings as text (do NOT write files).

### Implementation Plan

**Phase 1: <Description>**
1. <fix> (file:line — from @reviewer)
2. <fix> (file:line — from @reviewer)

**Phase 2: <Description>**
3. <fix> (file:line — from @reviewer)

Group related fixes. Separate unrelated areas into phases.
Each phase independently testable. 3-7 phases max.

### PR Replies

**Disagree**
- Re: @reviewer on file:line — <reply text with rationale>

**Already Done**
- Re: @reviewer on file:line — <reply pointing to handling>

**Questions**
- Re: @reviewer on file:line — <question to ask>

## Guidelines

- Read actual code, not just diff — context matters
- Check if reviewer might be looking at stale code
- Style/preference comments → lean "agree"
- Architectural suggestions → evaluate against broader codebase
- Cite code in rationale, not generalities
```

## Output Format

```
**PR Plan Task**: #<id>
**PR**: #<number> — <title>

**Triage**:
- N agree → planned
- N disagree → reply drafted
- N question → clarification needed
- N already-done → reply drafted

**Phases**: <count> implementation phases

**Plan**: `~/.claude/plans/<project>/pr-plan-<N>.md`
Review/edit in `$EDITOR` before `/prepare`.

**Replies**: `TaskGet(<id>)` → check `notes` field for draft
PR replies to post.

**Next**: `/prepare` to create tasks, or edit the plan first.
```
