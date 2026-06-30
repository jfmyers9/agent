---
name: research
description: >
  Create a durable, evidence-backed proposal for local review. Invoke only as
  /skill:research or $research when a proposal artifact is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<topic> | --continue [slug] | --discard [slug] | --depth <medium|high|max> | --auto"
---

# Research

Research a decision and write one proposal with one approval boundary.

@rules/blueprints.md, @rules/human-approval.md,
@rules/harness-compat.md, and @rules/artifact-readability.md apply.

## Arguments

- `<topic>` — decision to research
- `--continue [slug]` — resume the latest or matching proposal
- `--discard [slug]` — delete the latest or matching proposal and commit
- `--depth <medium|high|max>` — evidence depth; default `medium`
- `--auto` — approve immediately for an explicitly autonomous workflow

## Workflow

### 1. Resolve

- Continue/discard: `blueprint find --type proposal --match <slug>`.
- New work:
  `file=$(blueprint create proposal "<topic>" --status draft --depth <level>)`.
- Existing legacy specs/plans may be read as evidence; never create a new one.

### 2. Research

Inspect current behavior, relevant paths, local patterns, constraints, risks,
alternatives, and verification options. Spot-check at least three material
claims against source. Keep raw output out of the artifact.

Depth:

- `medium`: key paths and main tradeoffs
- `high`: affected modules, call paths, edge cases
- `max`: exhaustive boundaries, dependencies, and migration risks

For non-trivial flows, follow `@rules/artifact-readability.md`: include a small
diagram and evidence trace, or state why a diagram is unnecessary.

### 3. Write Proposal

Replace the generated section placeholders with:

```markdown
## Decision

- Decision requested:
- Recommendation:
- Scope / non-goals:
- Risks / open questions:

## Evidence

<current behavior, relevant paths, patterns, alternatives, confidence>

## Approach

<implementation-ready changes, affected files, ordering, verification>

## Acceptance Criteria

- [ ] <observable result>

## Implementation Notes

<empty until implementation, or prior notes when continuing>
```

Commit every write with `blueprint commit proposal <slug>`. Keep status
`draft` while awaiting a decision.

### 4. Approval

- Approval (`approve`, `approved`, `lgtm`, `ship it`): set `approved`, commit,
  and report `$implement <proposal>`.
- `$implement <proposal>` is itself explicit approval; implementation advances
  the proposal before editing code.
- Feedback: revise the same proposal, keep `draft`, commit, and return it once.
- `--auto`: set `approved` and commit without waiting.

Do not create a second planning artifact or a second approval stage.

## Output

```text
Proposal: <path>
Status: <draft|approved>
Next: <approve, give feedback, or $implement <proposal>>
```
