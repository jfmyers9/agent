---
name: diagnose
description: >
  Create a durable read-only root-cause report. Invoke only as /skill:diagnose
  or $diagnose when a persistent diagnosis artifact is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "<problem-description|blueprint-slug> [--continue]"
---

# Diagnose

Diagnose an issue without modifying code, and write a durable report.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Arguments

- `<problem-description>` — symptoms, errors, failing tests, CI links, logs, or
  affected paths to diagnose.
- `<blueprint-slug>` — existing diagnosis report to continue when it matches.
- `--continue` — resume the latest diagnosis report.

## Workflow

### 1. Resolve or Create Report

- If `--continue`, find the latest `report/` blueprint whose topic or body
  identifies it as a diagnosis report.
- If an argument matches an existing diagnosis report, read and continue it.
- Otherwise distill the problem statement from the arguments. Preserve exact
  error strings, paths, packages, PR numbers, timestamps, and symptoms.
- Create a report blueprint:

```bash
file=$(blueprint create report "Diagnosis: <problem>" --status draft)
```

### 2. Gather Shared Context

Gather only relevant context. Prefer bounded, targeted commands:

```bash
git status -sb
git diff --stat
git log --oneline --no-merges -30
# run a known failing test/check only when safe and specific
```

If the problem mentions paths, packages, tests, services, logs, or CI checks,
verify they exist before relying on them. Use bounded log reads and concise
searches. Do not dump broad logs or entire generated files.

Record context once and reuse it while synthesizing. Do not expand scope beyond
the problem unless evidence points to a specific adjacent fault domain.

### 3. Investigate

Trace:

- reproduction steps and whether they were execution verified
- expected versus actual behavior
- entrypoints, request/data flow, and state boundaries
- recent changes or configuration relevant to the failure
- root-cause hypotheses, including alternatives not yet ruled out
- evidence for and against each hypothesis

Use targeted tests, builds, probes, or read-only commands when they directly
increase confidence. Delete temporary probes after running them and capture the
result in the report.

Guardrails:

- Keep multiple plausible mechanisms visible when evidence does not localize
  the exact one. Do not collapse "one of A/B/C" into a single asserted cause.
- Distinguish source-present from actually wired, configured, deployed, or
  reachable in the failing path.
- Label every major claim with a verification method and confidence label from
  `@rules/artifact-readability.md`.
- Do not modify code, tests, config, labels, comments, or remote state.

### 4. Write Diagnosis Report

Write or update the report body:

```markdown
## Problem

<distilled problem, including exact errors and scope>

## Summary

<2-5 bullets with the most likely cause, confidence, and next action>

## Human-Readable Map

### System Map

<Mermaid flowchart or `Diagram omitted: <reason>`>

### Request / Data Flow

<Mermaid sequence diagram or `Diagram omitted: <reason>`>

### Flow Trace

| Step | Code / Config | Responsibility | Evidence |
| ---- | ------------- | -------------- | -------- |

## Reproduction Results

| Attempt | Command / Input | Result | Confidence |
| ------- | --------------- | ------ | ---------- |

## Root Cause Hypotheses

### H1: <title>

- Confidence: High | Medium | Low | Unknown
- Evidence for:
- Evidence against:
- What would prove/disprove it:

## Evidence Cross-Reference

| Hypothesis | Source evidence | Execution evidence | Tool data | Confidence |
| ---------- | --------------- | ------------------ | --------- | ---------- |

## Evidence Summary

| Claim | Evidence | Verification | Confidence |
| ----- | -------- | ------------ | ---------- |

## Recommended Actions

1. <specific fix, mitigation, or next diagnostic step>

## Investigation Log

- Commands run:
- Tests/probes:
- External docs/tools:
- Gaps:

## Open Questions

- <unknown, why it matters, how to answer>
```

### 5. Complete and Commit

Set status to `complete` when the diagnosis is written:

```bash
blueprint status "$file" complete
blueprint commit report <slug>
```

If `blueprint commit` exits non-zero, stop and show the error.

### 6. Output

```text
Diagnosis: <path>
Status: complete
Likely cause: <short summary>
Next: /skill:debug <diagnosis-slug> to fix, or /skill:research for design work
```

## Rules

- Read-only means no source edits and no remote state mutations.
- Prefer evidence-backed causes over plausible stories.
- Keep raw logs out of the main report; summarize and cite bounded excerpts.
- Keep workflow state in blueprints, not chat or harness-native stores.
