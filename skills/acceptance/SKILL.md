---
name: acceptance
description: >
  Create a durable review that verifies an implementation against explicit
  acceptance criteria. Invoke only as /skill:acceptance or $acceptance when a
  persistent verdict is wanted.
disable-model-invocation: true
user-invocable: true
argument-hint: "<criteria-source>"
allowed-tools: [Bash, Read, Glob, Grep, Write]
---

# Acceptance

Verify explicit criteria and store the evidence and verdict in a review
blueprint.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.
Immediately before committing, run `blueprint validate "$file"` and inspect the
entire blueprint repository. Stop if its index is nonempty or the current
project has changes outside `$file`: `blueprint commit` stages the project
subtree and commits the existing index.

## Arguments

- `<criteria-source>` — proposal, review, legacy blueprint, file path, or
  criteria stated in the request.

## Workflow

### 1. Resolve Criteria And Target

- Store an existing path in `source_file` and read it directly. Resolve a
  blueprint slug to one unambiguous `source_file` with:

  ```bash
  blueprint find --type proposal,review,spec,plan --match <slug>
  ```

- Prefer `## Acceptance Criteria`; otherwise use explicit legacy completion
  criteria or unresolved findings. Do not invent missing criteria.
- Record both the criteria source and the implementation target. If the target
  is not explicit, use the current branch plus working-tree changes and state
  that assumption.
- If no objective criteria can be identified, ask the user what to verify.

### 2. Verify

Inspect the implementation and apply two lenses:

- **Verifier:** evaluate every criterion as `PASS`, `PARTIAL`, `FAIL`, or `N/A`.
  Cite the strongest available source and execution evidence; explain every
  `PARTIAL` and `N/A` result.
- **Breaker:** probe implied requirements, edge cases, integration boundaries,
  negative behavior, and technically complete but unusable outcomes. Convert
  material gaps into findings and map them to a criterion or label them as an
  implied requirement.

Run focused checks when safe. Do not modify the implementation. Label evidence
with the verification terms from `@rules/artifact-readability.md`; state
confidence separately. For a multi-boundary acceptance path, add the rule's
small diagram and trace table; otherwise record why a diagram is unnecessary.

Set the overall verdict:

- `FAIL` — any criterion fails, or a breaker proves required behavior is unmet.
- `PARTIAL` — nothing fails, but a criterion is partial or a material
  requirement remains unverified.
- `PASS` — every applicable criterion passes and no material breaker remains.

### 3. Store The Review

```bash
file=$(blueprint create review "Acceptance: <target>" --status complete)
```

Link the review only when the criteria source is a blueprint:

```bash
source_slug=$(basename "$source_file" .md)
blueprint link "$file" "$source_slug"
```

Write:

```markdown
## Acceptance Verdict

- Verdict: PASS | PARTIAL | FAIL
- Criteria source: <path, slug, or request>
- Implementation target: <branch, diff, or path>
- Results: <pass/partial/fail/n-a counts>

## Human-Readable Map

<diagram and trace for a multi-boundary path, or `Diagram omitted: <reason>`>

## Criteria Matrix

| Criterion | Result | Breaker flags | Evidence |
| --------- | ------ | ------------- | -------- |

## Findings

### F001: <short title>

- Severity: critical | high | medium | low
- Location: `<path:line>` or `cross-file`
- Verification: source reading | execution verified | production/tool data |
  inferred
- Confidence: High | Medium | Low

<unmet behavior, impact, and specific correction>

## Resolutions

| Finding | Outcome | Change | Verification |
| ------- | ------- | ------ | ------------ |

## What I Verified

- <command, inspection, or probe and result>
```

Assign stable sequential finding IDs. Omit `## Findings` and `## Resolutions`
when there are no findings. Commit the completed artifact with
`blueprint commit review <slug>`; stop and show the error if the commit fails.

### 4. Report

Return the artifact path, verdict, result counts, and finding IDs. Suggest
`$fix <review>` when gaps exist or `$commit` after a pass. Do not create or
execute a fix plan.
