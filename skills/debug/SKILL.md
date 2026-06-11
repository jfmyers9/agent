---
name: debug
description: >
  Systematically diagnose and fix bugs, CI failures, and test
  failures. Use `diagnose` first for read-only root-cause reports.
  Triggers: /debug, debugging issues, test failures, CI errors.
allowed-tools: Bash, Read, Glob, Grep, Edit, Write
argument-hint: "[blueprint-slug|error-description]"
---

# Debug

Diagnose and fix a bug using a `plan/` blueprint as the durable work
record.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Arguments

- `<blueprint-slug>` — continue a matching debug/fix plan or use a
  completed diagnosis report as root-cause input
- `<error-description>` — problem to debug
- no args — inspect current branch/tests for failures

## Workflow
Use `/skill:diagnose` when the user asks only to understand an issue, produce
a root-cause report, or avoid code changes. Use this skill when fixes are in
scope.


### 1. Resolve or Create Plan

- If a slug matches `blueprint find --type plan --match <slug>`, read
  and continue it.
- Else if a slug matches a completed diagnosis `report/` blueprint, read it
  and use its root-cause hypotheses, evidence, and recommended actions as
  input to the debug plan.
- Else gather problem context from args, failing tests, CI output, or
  recent logs.
- Create a plan blueprint:
  ```bash
  file=$(blueprint create plan "Debug: <problem>" --status draft)
  ```

### 2. Diagnose

Gather only relevant context:

```bash
git status -sb
git diff --stat
# run the failing test/check if known
```

Trace:

- reproduction steps and whether they were execution verified
- expected vs actual behavior
- suspected files/functions
- root cause evidence, confidence labels, and any remaining alternative
  mechanisms from an input diagnosis

Write/update the blueprint:

```markdown
## Problem

## Human-Readable Map

### System Map

<Mermaid flowchart or `Diagram omitted: <reason>`>

### Request / Data Flow

<Mermaid sequence diagram or `Diagram omitted: <reason>`>

## Reproduction

## Root Cause

## Evidence Summary

| Claim | Evidence | Verification | Confidence |
| ----- | -------- | ------------ | ---------- |

## Fix Plan

**Phase 1: Minimal Fix**
- Files:
- Steps:
- Verify:
```

Run `blueprint commit plan <slug>` after writes.

### 3. Fix

Make the smallest change that addresses the root cause. Avoid adjacent
refactors. Verify with the failing test/check first, then related checks
as needed.

Append:

```markdown
## Debug Notes
- Files changed:
- Verification:
- Remaining risks:
```

### 4. Complete

If fixed and verified:

```bash
blueprint status "$file" complete
blueprint commit plan <slug>
```

Report:

```text
Problem: <summary>
Root Cause: <summary>
Fix: <files>
Verification: <commands/results>
```
