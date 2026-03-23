---
name: fix
description: >
  Convert user feedback on recent implementations into tasks.
  Triggers: /fix, "fix this", "create issues from feedback"
allowed-tools: Bash, Read, Write, Glob, Grep, TaskCreate, TaskUpdate, TaskGet
argument-hint: "[feedback-text]"
---

# Fix

Convert user feedback into structured tasks.

## Plan Directory

@rules/blueprints.md — prefix: `fix-`, e.g. `fix-<slug>.md`.

## Arguments

- `<feedback-text>` — feedback to convert (may reference files,
  behaviors, or recent changes)
- (no args) — ask user for feedback

## Workflow

### 1. Gather Context (Parallel)

Run these in parallel to understand what was recently implemented:
```bash
git diff --name-only HEAD~3..HEAD
git log --oneline -5
git branch --show-current
```

If user references specific files, read those files.

### 2. Analyze Feedback

Break feedback into individual findings:
- Classify each: `bug`, `task`, or `feature`
- Set priority (P0-P4):
  - P0: Critical bugs, blocking issues
  - P1: Important bugs, high-priority features
  - P2: Normal priority (default for most feedback)
  - P3: Nice-to-have improvements
  - P4: Low priority, future consideration
- Group findings by type for phase structure

### 3. Create Single Task with Phased Design

Create ONE task containing all findings:

- TaskCreate:
  - subject: "Fix: <brief-summary-of-feedback>"
  - description: "All feedback items addressed. Findings stored in task metadata design field as phased structure. Consumable by `/implement` for epic creation."
  - metadata: {type: "task", priority: 2}
- TaskUpdate(taskId, status: "in_progress")

Then structure findings as phases and store in both plan file and
task metadata:

a. Generate a kebab-case slug from the feedback summary (lowercase,
   strip filler words, replace non-alnum with hyphens, max 50 chars)
b. Write plan file:
   ```
   Write("~/workspace/blueprints/<project>/fix-<slug>.md", <frontmatter + findings>)
   ```
   Frontmatter:
   ```yaml
   ---
   topic: "Fix: <brief-summary>"
   project: <absolute path to cwd>
   created: <ISO 8601 timestamp>
   status: draft
   ---
   ```
c. Store in task: TaskUpdate(taskId, metadata: {design: "<phased-findings>", plan_file: "fix-<slug>.md"})

Design field format:
```
## Feedback Analysis

**Phase 1: Bug Fixes**
1. Fix X in file.ts:123 — description of bug
2. Fix Y in module.ts:45 — description of bug

**Phase 2: Improvements**
3. Update Z configuration — description of improvement
4. Add W feature — description of feature

Each phase groups findings by type (bugs first, then tasks,
then features). Skip empty phases.
```

**Phase grouping rules:**
- Phase 1: Bugs (highest priority first)
- Phase 2: Tasks / improvements
- Phase 3: Features / new functionality
- Skip phases with no findings
- Each item: actionable title with file:line when available

### 4. Report

#### Blueprints Commit

If any blueprints files were written or moved during this session,
commit them per `@rules/blueprints.md`:
```sh
cd ~/workspace/blueprints && \
  git add -A <project>/ && \
  git commit -m "fix(<project>): <slug>"
```

Output format:
```
## Fix Task: #<id>

**Findings**: N items (X bugs, Y tasks, Z features)

**Plan**: `~/workspace/blueprints/<project>/fix-<slug>.md` — review/edit in
`$EDITOR` before `/implement`.

**Next**: `/implement` to create tasks, or edit the plan file first.
```

## Style Rules

- Keep concise — bullet points, not prose
- No emoji
- All findings in one task — grouped by type in design phases
- Use specific file paths and line numbers when available
- Classify accurately (bug vs task vs feature matters for grouping)
- Default to P2 unless feedback indicates urgency
