---
name: implement
description: >
  Implement requested work from freeform instructions or an existing proposal,
  review, or legacy blueprint. Use when the user asks to build or change code.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[instructions|blueprint-slug-or-path]"
---

# Implement

Implement freeform work or an existing artifact. Blueprints are optional input.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Inputs

- Freeform request — use the conversation as the execution source.
- File path — read that proposal, review, report, or legacy blueprint.
- Slug — resolve with
  `blueprint find --type proposal,review,report,spec,plan --match <slug>`.
- No artifact — proceed directly; do not search for or create one.

Explicitly invoking this skill with a draft proposal authorizes it. Set the
proposal to `approved` and commit before source edits. Reviews and legacy
artifacts require no particular status; explicit implementation is sufficient
authorization.

## Workflow

### 1. Bound Work

Inspect `git status --short`, read referenced files, and extract required
changes plus acceptance checks. For a review, implement actionable unresolved
findings. For freeform work, derive the smallest safe execution sequence.

### 2. Implement

For each cohesive change:

1. Read affected code and tests.
2. Make the smallest complete change.
3. Preserve unrelated user changes.
4. Run the narrowest useful verification, then broader checks as risk warrants.

Stop and report genuine blockers. Do not create a tracker or report artifact.

### 3. Update Source Artifact When Present

- Proposal: append concise changes and verification under
  `## Implementation Notes`; set `complete` only after all criteria pass.
- Review: leave finding resolution updates to `fix`, unless implementation was
  explicitly invoked on that review; then add/update its resolution table.
- Legacy spec/plan: append implementation notes and preserve readable legacy
  status behavior.

Commit each artifact write with its artifact type.

### 4. Report

Return files changed, verification commands/results, and any remaining work.
Suggest `$review` or `$commit` when useful. Generate a report artifact only
when the user invokes `$report`.

## Rules

- Freeform implementation requires no blueprint.
- A named proposal or review constrains scope but does not replace source
  inspection.
- Revalidate findings before changing code.
- Do not create harness-native durable state.
