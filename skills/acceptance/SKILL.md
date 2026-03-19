---
name: acceptance
description: >
  Validate implementation against acceptance criteria using
  dual-agent verification. Triggers: 'accept', 'acceptance check',
  'verify implementation', 'did it work'.
argument-hint: "[<task-id>] [--auto]"
user-invocable: true
allowed-tools:
  - Agent
  - Bash
  - Read
  - Glob
  - Grep
  - TaskGet
  - TaskList
---

# Acceptance

Dual-agent post-implementation verification: a Verifier checks
each criterion, a Breaker hunts for gaps. Reconcile results into
a single verdict.

## Arguments

- `<task-id>` — verify a specific task's acceptance criteria
- `--auto` — auto-fix failures (max 2 iterations)
- *(none)* — find most recent in_progress/completed task

Run after `/implement` completes — verifies the holistic outcome
at the epic level, not individual task results.

## Workflow

### Step 1: Resolve Target

1. If `$ARGUMENTS` contains a task ID → `TaskGet(taskId)`
2. Else → `TaskList()`, prefer tasks where
   `metadata.type == "epic"` (most recent first), then fall back
   to any `in_progress` or `completed` task
3. Extract criteria from the task description — look for
   `## Success Criteria` (epics) or `## Acceptance Criteria`
   (tasks), use whichever is found
4. If neither found → ask user what to verify

### Step 2: Gather Diff

If target is an epic (`metadata.type == "epic"`):

```bash
# Full branch diff — captures all changes across all tasks
diff=$(git diff $(git merge-base HEAD $(gt trunk 2>/dev/null || echo main))..HEAD)
```

If target is a regular task:

```bash
# Try uncommitted changes first
diff=$(git diff HEAD; git diff --cached)
# If empty, use last commit
[ -z "$diff" ] && diff=$(git diff HEAD~1..HEAD)
```

If no diff at all → exit: "Nothing to verify — no changes found."

Build a diff summary: changed file list + key changes (truncate
files with >200 lines of diff to first 50 + last 50 lines).

### Step 3: Verify (parallel agents)

Spawn BOTH agents in a SINGLE message for true parallelism.

#### Verifier

```
Agent(subagent_type="general-purpose", prompt=<below>)
```

```
Evaluate this implementation against acceptance criteria.

## Acceptance Criteria
<criteria from task>

## Changes
<diff summary — file list + key changes>

For EACH criterion, evaluate:
- PASS: criterion fully met, cite file:line evidence
- PARTIAL: criterion partially met, explain gap
- FAIL: criterion not met, explain why
- N/A: criterion not applicable to these changes

Return a structured report with one entry per criterion.
Do NOT write files.
```

#### Breaker

```
Agent(subagent_type="general-purpose", prompt=<below>)
```

```
You are an adversarial tester. Hunt for issues the verifier
might miss.

## Acceptance Criteria
<criteria from task>

## Changes
<diff summary>

Evaluate ALL 5 angles — provide analysis for each:
1. Implied requirements: what the criteria assume but don't state
2. Edge cases: boundary conditions, empty inputs, overflow
3. Integration points: how changes interact with existing code
4. Technically-met-but-incomplete: letter vs spirit of criteria
5. Missing negatives: things that should NOT happen but aren't
   tested

For each finding, rate: HIGH / MEDIUM / LOW severity.
If an angle has no findings, explain why (no lazy "none found").
Do NOT write files.
```

### Step 4: Reconcile

Collect both agent results. Apply verdict rules:

| Condition | Verdict |
|---|---|
| Any Verifier FAIL | **FAIL** |
| Any Verifier PARTIAL | **PARTIAL** |
| All PASS + any Breaker HIGH | **PARTIAL** |
| All PASS + no Breaker HIGH | **PASS** |

After computing the verdict, detect consensus findings:

- For each Verifier criterion rated PARTIAL or FAIL, check if the
  Breaker flagged the same area as HIGH or MEDIUM severity
- If both independently flagged the same area → tag as
  **Consensus Finding** (highest-confidence issues)
- Collect all consensus findings for the report (may be empty)

### Step 5: Report and Act

Display verdict with summary table:

```
## Acceptance: <PASS|PARTIAL|FAIL>

| Criterion | Verifier | Breaker Flags |
|---|---|---|
| <criterion> | PASS/PARTIAL/FAIL | HIGH/MEDIUM/LOW or — |

### Consensus Findings
(only include if overlap detected)

| Criterion | Verifier Verdict | Breaker Severity | Notes |
|---|---|---|---|
| <criterion> | PARTIAL/FAIL | HIGH/MEDIUM | <brief description> |

### Verifier Details
<structured per-criterion results>

### Breaker Findings
<adversarial findings by angle>
```

**On PASS**: Report success, suggest `/commit`.

**On PARTIAL or FAIL with `--auto`**:
1. Spawn fix agent with findings (max 2 iterations)
2. Re-run verification after fix
3. If still failing after 2 iterations → report and stop

**On PARTIAL or FAIL without `--auto`**:
Present options:
1. **Fix** — spawn agent to address findings
2. **Override** — accept as-is with noted caveats
3. **Tasks** — create follow-up tasks for unresolved findings
4. **Re-run** — re-verify after manual fixes
