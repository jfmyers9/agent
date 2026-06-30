---
name: simplify
description: >
  Create a durable read-only simplification report for a design document.
  Invoke only as /skill:simplify or $simplify.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "<blueprint-slug-or-path> [--scope <area>]"
---

# Simplify

Review a blueprint or design document and write a simplification report.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Arguments

- `<blueprint-slug-or-path>` — blueprint, design doc, plan, or markdown file to
  simplify.
- `--scope <area>` — optional section, module, or concern to focus on.

## Workflow

### 1. Resolve Source

- If an explicit path exists, read it.
- Else resolve a matching blueprint with:
  `blueprint find --type proposal,report,spec,plan --match <arg>`.
- If no source is provided, stop and ask for a blueprint slug or path.
- If a blueprint source is found, link the simplification report to it after
  creating the report.

Create a report blueprint:

```bash
file=$(blueprint create report "Simplify: <source-title>" --status draft)
blueprint link "$file" "<source-slug>" # when source is a blueprint
```

### 2. Understand Existing Design

Read only what is needed to evaluate complexity:

- goals, non-goals, acceptance criteria, and constraints
- proposed interfaces, data structures, APIs, and config
- phased plan and dependencies
- existing code paths referenced by the source document
- local patterns that the design should preserve

When the source references code or systems, inspect relevant files before
making recommendations. Do not rewrite the source document or edit code.

### 3. Analyze Simplification Opportunities

Look for:

- redundant or overlapping interfaces
- avoidable public API surface
- complex data flow that can become linear or local
- unclear module boundaries or mixed responsibilities
- abstractions that do not remove real duplication or complexity
- phases that can merge, split, or reorder around true dependencies
- comments or documentation that obscure the core decision

Prefer recommendations that make the plan smaller, safer, or easier to review.
Do not recommend speculative rewrites that increase scope without reducing a
specific complexity.

### 4. Write Simplification Report

```markdown
## Summary

- Recommendations: <count>
- By type: Merge <n> | Extract <n> | Remove <n> | Restructure <n> | Clarify <n>
- Overall assessment: Simple | Mostly simple | Too complex | Needs redesign

## Human-Readable Map

### Current Shape

<Mermaid flowchart or `Diagram omitted: <reason>`>

### Proposed Simpler Shape

<Mermaid flowchart or `Diagram omitted: <reason>`>

## Recommendations

### 1. <short title>

- Type: Merge | Extract | Remove | Restructure | Clarify
- Location: <source section, path, or symbol>
- Current state: <quote or description>
- Proposed change: <specific simplification>
- Rationale: <why this improves reviewability, correctness, or maintainability>
- Risk assessment:
  - Functionality impact: None | Low | Medium | High
  - Correctness impact: None | Low | Medium | High
- Verification: <source reading, execution verified, production/tool data,
  inferred>

## Recommendations Not Made

- <area>: <why simplification would be harmful or out of scope>

## Evidence Summary

| Claim | Evidence | Verification | Confidence |
| ----- | -------- | ------------ | ---------- |

## Open Questions

- <question, why it matters, how to answer>
```

### 5. Complete and Commit

```bash
blueprint status "$file" complete
blueprint commit report <slug>
```

If `blueprint commit` exits non-zero, stop and show the error.

### 6. Output

```text
Simplification: <path>
Status: complete
Recommendations: <count>
Next: apply manually, revise the source, or $implement <proposal>
```

## Rules

- Report only. Do not modify the source document or code.
- Keep recommendations specific and tied to the source goals.
- Avoid additions unless they reduce real complexity or clarify a boundary.
- Keep workflow state in blueprints, not chat or harness-native stores.
