---
name: diagnose
description: >
  Create a durable, read-only diagnosis report for a failure or unexpected
  behavior. Invoke only as /skill:diagnose or $diagnose when persistent
  root-cause evidence is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<problem-description> | --continue [slug]"
---

# Diagnose

Investigate without changing product code or target-system state, then store
the evidence and conclusions in a report blueprint.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.
Immediately before committing, run `blueprint validate "$file"` and inspect the
entire blueprint repository. Stop if its index is nonempty or the current
project has changes outside `$file`: `blueprint commit` stages the project
subtree and commits the existing index.

## Arguments

- `<problem-description>` — symptoms, exact errors, failing checks, logs, links,
  or affected paths.
- `--continue [slug]` — continue the latest or matching diagnosis report.

## Workflow

### 1. Resolve The Investigation

- With `--continue <slug>`, resolve
  `blueprint find --type report --match <slug>` and confirm it is a diagnosis
  report. Store the unambiguous resolved path in `file`.
- With bare `--continue`, identify the latest report whose topic or body marks
  it as a diagnosis. Do not use an unrelated generic report. Store its path in
  `file`.
- Read a continued report and resume from its problem statement, evidence,
  hypotheses, gaps, and snapshot. Update that file in place.
- For new work, distill the problem from the request. Preserve exact error
  strings, paths, packages, PR numbers, timestamps, and observed symptoms.

### 2. Gather Bounded Context

Inspect only evidence relevant to the failure. Start with repository state,
the affected paths, recent relevant changes, and one known failing check when
it is safe and specific. Verify that named paths, packages, tests, services,
logs, and CI checks exist before relying on them.

Use concise searches and bounded log reads. Record shared context once and
reuse it. Expand beyond the initial scope only when evidence identifies a
specific adjacent fault domain.

### 3. Test Competing Explanations

Trace:

- reproduction attempts and whether each was execution verified
- expected versus observed behavior
- entrypoints, request/data flow, state, and external boundaries
- recent code, configuration, or environment changes relevant to the failure
- competing root-cause hypotheses and evidence for and against each
- the next observation that would prove or disprove unresolved hypotheses

Run targeted tests, builds, and read-only probes only when they increase
confidence. Do not edit product code, tests, configuration, labels, comments,
or target-system remote state. Blueprint persistence is the sole authorized
external write. Do not leave probe files or tool-generated tracked changes in
the working tree.

Keep multiple mechanisms visible until evidence distinguishes them. Do not
equate source presence with code being wired, configured, deployed, or
reachable. Label verification with the evidence terms from
`@rules/artifact-readability.md`, and state confidence separately.

### 4. Write The Diagnosis Report

After investigating new work, create the report as complete:

```bash
file=$(blueprint create report "Diagnosis: <problem>" --status complete)
```

For continued work, edit the resolved file. Write:

```markdown
## Summary

<2-5 bullets: confirmed cause or leading hypotheses, confidence, impact, and
next action>

## Problem

<distilled symptoms, exact errors, expected behavior, and scope>

## Human-Readable Map

### System Map

<Mermaid flowchart or `Diagram omitted: <reason>`>

### Request / Data Flow

<Mermaid sequence diagram or `Diagram omitted: <reason>`>

### Flow Trace

| Step | Code / Config | Responsibility | Evidence |
| ---- | ------------- | -------------- | -------- |

## Reproduction Results

| Attempt | Command / Input | Result | Verification |
| ------- | --------------- | ------ | ------------ |

## Root-Cause Hypotheses

### H1: <short title>

- Status: Confirmed | Leading | Plausible | Ruled out
- Confidence: High | Medium | Low | Unknown
- Evidence for:
- Evidence against:
- What would prove or disprove it:

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

- <unknown, why it matters, and how to answer it>
```

A complete report may remain inconclusive; `complete` means the documented
investigation is finished, not that a cause was proven.

### 5. Commit And Report

Run `blueprint commit report <slug>` after each body revision. If a continued
report is still draft, commit the body first, then set it to complete and
commit that status change separately:

```bash
blueprint status "$file" complete
blueprint commit report <slug>
```

Stop and show any commit error. Return:

```text
Diagnosis: <path>
Status: complete
Conclusion: <confirmed cause, leading hypothesis, or inconclusive>
Next: $debug <diagnosis-slug> to fix, or $research for a design decision
```
