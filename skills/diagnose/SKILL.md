---
name: diagnose
description: >
  Create a durable, read-only diagnosis of a failure or unexpected behavior.
  Invoke only as /skill:diagnose or $diagnose when persistent root-cause
  evidence is wanted; use debug when the user wants a fix.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<problem-description> | --continue [slug]"
---

# Diagnose

Investigate without changing product code or target-system state, then store
the evidence and conclusions in a diagnosis report.

@rules/blueprints.md, @rules/context-budget.md,
@rules/harness-compat.md, and @rules/artifact-readability.md apply.

## Workflow

### 1. Resolve The Investigation

For `--continue <slug>`, resolve exactly one report with
`blueprint find --type report --kind diagnosis --match <slug>`. With bare
`--continue`, use the latest result from
`blueprint find --type report --kind diagnosis`. Read and update that report in
place. Compare its snapshot with current repository and external state before
reusing earlier conclusions.

If no typed result exists, inspect `blueprint find --type report --all` and
accept only one legacy report whose topic and body clearly identify it as a
diagnosis. Add `kind: diagnosis` during the update. Never choose an untyped
generic report by recency alone.

For new work, distill the symptoms, expected behavior, exact errors, affected
paths or services, timestamps, and known reproduction. Verify named paths,
packages, checks, and external evidence exist before relying on them.

### 2. Test Competing Explanations

Start with one narrow reproducer or safe read-only probe. Bound logs at their
source. Trace entrypoints, data and state flow, external boundaries, and recent
relevant changes. Keep competing hypotheses visible until evidence
distinguishes them; for each, record:

- evidence for and against;
- whether evidence came from source, execution, or external tool data;
- confidence and remaining uncertainty; and
- the next observation that would prove or disprove it.

Do not equate source presence with code being wired, configured, deployed, or
reachable. Do not edit product code, tests, configuration, labels, comments, or
target-system remote state. Remove any temporary probe output from the product
worktree.

### 3. Write One Concise Report

For new work:

```sh
file=$(blueprint create report "Diagnosis: <problem>" --status complete --kind diagnosis)
```

Use only relevant sections:

```markdown
## Summary

## Problem And Snapshot

## Reproduction Results

## System / Failure Flow

## Root-Cause Hypotheses

## Evidence

## Recommended Actions

## Open Questions
```

A complete report may remain inconclusive: `complete` means the bounded
investigation is documented, not that a cause was proven. Include a small map
only when path, state, or timing across boundaries is material to the diagnosis.

### 4. Validate, Commit, And Report

For a continued draft report, set it to complete before committing. Then run:

```sh
blueprint validate "$file"
blueprint commit report "$file"
```

The CLI commits only the exact report and refuses a dirty blueprint index. Stop
on any error. Return the report path, conclusion, confidence, snapshot, and next
discriminating action. Suggest `$debug` only when the user wants the fix applied.
