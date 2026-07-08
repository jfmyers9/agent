---
name: implement
description: >
  Implement requested code changes from freeform instructions or a named
  proposal, review, report, or legacy blueprint. Use when the user asks to build
  or change code.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[instructions|blueprint-slug-or-path]"
---

# Implement

Deliver the requested change with proportionate verification. Artifacts are
optional inputs, never prerequisites.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Inputs

- Freeform request — use the conversation as the execution source.
- Explicitly named artifact path — store it in `file`, derive its artifact
  slug, and read that proposal, review, report, or legacy blueprint.
- Slug — resolve one unambiguous file with
  `blueprint find --type proposal,review,report,spec,plan --match <slug>`, then
  store its path in `file` and derive its artifact slug.
- No artifact — proceed directly; do not search for or create one.

Explicitly invoking this skill with a draft proposal authorizes it. Set the
proposal to `approved` and commit before source edits, using the artifact safety
checks in step 3. Reviews and legacy artifacts require no particular status;
explicit implementation is sufficient authorization.

## Workflow

### 1. Bound Work

Read applicable repository instructions and inspect `git status --short` before
editing. Preserve unrelated work. Read the named artifact and relevant source,
then extract scope, constraints, acceptance criteria, and verification. For a
review, revalidate and implement only actionable unresolved findings. For
freeform work, derive the smallest safe execution sequence.

### 2. Implement

For each cohesive change:

1. Read affected code and tests.
2. Confirm the expected behavior and important failure boundaries.
3. Make the smallest complete change without unrelated refactoring.
4. Add or update tests only where they protect realistic behavior.
5. Run the narrowest useful verification, then broader checks as risk warrants.
6. Inspect the resulting diff for scope, correctness, and accidental churn.

Continue through recoverable failures. Stop and report genuine blockers with
the exact evidence or decision needed to proceed. Do not create a tracker or
report artifact.

### 3. Update Source Artifact When Present

- Proposal: append concise changes and verification under
  `## Implementation Notes`; set it to `complete` only after all acceptance
  criteria pass. Leave a partial implementation `approved`. Commit the notes
  first, then change and commit status separately.
- Review: leave finding resolution updates to `fix`, unless implementation was
  explicitly invoked on that review; then add/update its resolution table.
- Legacy spec/plan: append implementation notes and preserve readable legacy
  status behavior.

Preserve artifact frontmatter and write below the closing `---`. Immediately
before each artifact commit, run `blueprint validate "$file"` and inspect the
entire blueprint repository. Stop if its index is nonempty or the current
project has changes outside `$file`: `blueprint commit` stages the project
subtree and commits the existing index. Then run
`blueprint commit <type> <slug>` and stop on failure. This does not authorize a
source-code commit.

### 4. Report

Return the outcome, files changed, verification commands and results, and any
remaining work or risk. Suggest `$review` or `$commit` only when useful.
Generate a report artifact only when the user explicitly invokes `$report`.

## Rules

- Freeform implementation requires no blueprint.
- A named proposal or review constrains scope but does not replace source
  inspection.
- Revalidate findings before changing code.
- Preserve unrelated working-tree changes and never stage or commit them.
- Do not create harness-native durable state.
