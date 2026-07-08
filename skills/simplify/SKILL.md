---
name: simplify
description: >
  Create a durable, read-only simplification review of a design document.
  Invoke only as /skill:simplify or $simplify when a persistent report is
  wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "<blueprint-slug-or-path> [--scope <area>]"
---

# Simplify

Evaluate a design for unnecessary complexity and store evidence-backed,
scope-preserving recommendations in a report blueprint.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.
Immediately before committing, run `blueprint validate "$file"` and inspect the
entire blueprint repository. Stop if its index is nonempty or the current
project has changes outside `$file`: `blueprint commit` stages the project
subtree and commits the existing index.

## Arguments

- `<blueprint-slug-or-path>` — proposal, report, legacy blueprint, design plan,
  or Markdown document to evaluate.
- `--scope <area>` — optional section, module, or concern to evaluate.

## Workflow

### 1. Resolve And Bound The Source

- Store an existing path in `source_file` and read it directly. Otherwise
  resolve one unambiguous `source_file` with
  `blueprint find --type proposal,report,spec,plan --match <slug>`.
- If no source is provided, ask for a slug or path before continuing.
- Record the requested scope and the source goals, non-goals, acceptance
  criteria, and constraints that recommendations must preserve.
- When the source is a blueprint, retain its full filename stem for linking.
  Do not create the simplification report until the analysis is ready to write.

### 2. Verify The Existing Design

Read only the material source sections and referenced code needed to evaluate:

- interfaces, data structures, APIs, and configuration
- module boundaries, ownership, and data/control flow
- phases, ordering constraints, and dependencies
- existing local patterns the design should preserve

Verify referenced code and systems before making claims about them. Do not
rewrite the source document or modify product code.

### 3. Identify Simpler Alternatives

Look for:

- redundant or overlapping interfaces
- avoidable public API or configuration surface
- data/control flow that can become linear or local
- unclear boundaries or mixed responsibilities
- abstractions that do not remove real duplication or risk
- phases that can merge, split, or reorder around actual dependencies
- wording or documentation that obscures the core decision

Keep only recommendations that make the design smaller, safer, or easier to
review while preserving its stated goals. Reject speculative rewrites and
scope expansion unless they remove a specific, evidenced complexity.

### 4. Write The Complete Report

```bash
file=$(blueprint create report "Simplify: <source-title>" --status complete)
```

Link a blueprint source:

```bash
source_slug=$(basename "$source_file" .md)
blueprint link "$file" "$source_slug"
```

Write:

```markdown
## Summary

- Overall assessment: Simple | Mostly simple | Too complex | Needs redesign
- Recommendations: <count>
- By type: Merge <n> | Extract <n> | Remove <n> | Restructure <n> | Clarify <n>
- Source goals preserved: <short statement>

## Human-Readable Map

### Current Shape

<Mermaid flowchart or `Diagram omitted: <reason>`>

### Proposed Simpler Shape

<Mermaid flowchart or `Diagram omitted: <reason>`>

### Design Trace

| Element | Source / Code | Current responsibility | Proposed change | Evidence |
| ------- | ------------- | ---------------------- | --------------- | -------- |

## Recommendations

### 1. <short title>

- Type: Merge | Extract | Remove | Restructure | Clarify
- Location: <source section, path, or symbol>
- Current state: <concise quote or description>
- Proposed change: <specific simplification>
- Rationale: <concrete reduction in complexity or risk>
- Functionality risk: None | Low | Medium | High
- Correctness risk: None | Low | Medium | High
- Verification: source reading | execution verified | production/tool data | inferred
- Confidence: High | Medium | Low

## Recommendations Not Made

- <area>: <why simplification would be harmful or out of scope>

## Evidence Summary

| Claim | Evidence | Verification | Confidence |
| ----- | -------- | ------------ | ---------- |

## Open Questions

- <question, why it matters, and how to answer it>
```

Include current/proposed diagrams only when they clarify a non-trivial design;
otherwise use one omission reason. Omit `## Recommendations Not Made` and
`## Open Questions` when empty.

### 5. Commit And Report

Run `blueprint commit report <slug>` and stop on any error. Return:

```text
Simplification: <path>
Status: complete
Recommendations: <count>
Next: revise the source, or $implement <report> for requested code changes
```

The report is advisory. Do not modify its source or implement recommendations
within this skill.
