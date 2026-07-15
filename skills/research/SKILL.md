---
name: research
description: >
  Create a durable, evidence-backed proposal for a technical decision. Invoke
  only as /skill:research or $research when a proposal artifact is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: >
  <topic> | --continue [slug] [--depth <medium|high|max>] [--auto]
---

# Research

Research one decision and write one proposal with one approval boundary.

@rules/blueprints.md, @rules/human-approval.md,
@rules/harness-compat.md, and @rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.

## Arguments

- `<topic>` — decision to research.
- `--continue [slug]` — revise the latest or matching proposal.
- `--depth <medium|high|max>` — evidence depth; default `medium`.
- `--auto` — approve the resulting proposal without waiting for a separate
  approval response.

Require a topic for new work. Use `blueprint archive` for lifecycle cleanup;
research never deletes a proposal.

## Workflow

### 1. Resolve The Mode

- Continue a named proposal with
  `blueprint find --type proposal --match <slug>`. With no slug, resolve the
  latest proposal. Store its path in `file`; explicit matches must resolve
  unambiguously before changing it.
- For `--continue`, read the full proposal and preserve still-valid decisions,
  evidence, and implementation notes.
- For new work, do not create the proposal until the research is ready to
  write. Existing legacy specs and plans may be evidence; never create one.

### 2. Research The Decision

Inspect current behavior, relevant paths, local conventions, constraints,
risks, alternatives, and verification options. Verify every material
current-state claim against source; check at least three claims when the
proposal contains that many. Separate observed evidence from inference and
keep raw command output out of the artifact. Do not modify product code or
target-system remote state during research; proposal persistence is the sole
authorized external write.

When continuing in response to simplification feedback, identify redundant
interfaces, avoidable phases, speculative abstractions, and nonessential public
surface. Revise the same proposal so its goals and acceptance criteria remain
the single source of truth; do not create a separate simplification report.

Depth controls breadth:

- `medium` — key paths and primary tradeoffs.
- `high` — affected modules, call paths, failure modes, and edge cases.
- `max` — reachable boundaries, dependencies, compatibility, and migration
  risks.

For non-trivial architecture or flow, put a small diagram and its evidence
trace under `## Evidence` when it is clearer than prose.

### 3. Write One Proposal

For new work, create the proposal as `draft`, or as `approved` when `--auto`
is present:

```bash
status=draft # use approved when --auto is present
file=$(blueprint create proposal "<topic>" --status "$status" --depth "<level>")
```

For continued work, update the same file. Replace or preserve the generated
sections so the proposal contains:

```markdown
## Decision

- Decision requested:
- Recommendation:
- Scope / non-goals:
- Risks / open questions:

## Evidence

<current behavior, relevant paths, alternatives, evidence labels, confidence>

## Approach

<implementation-ready changes, affected files, ordering, and verification>

## Acceptance Criteria

- [ ] <observable result>

## Implementation Notes

<empty before implementation; preserve existing notes when continuing>
```

Validate and commit each body revision with
`blueprint commit proposal "$file"`. When
`--auto` advances an existing draft, commit the body revision first, then run
`blueprint status "$file" approved` and commit that status change separately.
Stop and show any commit error.

### 4. Apply The Approval Boundary

- Explicit approval (`approve`, `approved`, `lgtm`, `ship it`): set the same
  proposal to `approved` and commit the status change.
- `$implement <proposal>` is itself explicit approval; implementation advances
  a draft before editing source.
- Feedback: if the proposal is approved, return it to `draft` and commit that
  status change. Revise and commit the same proposal, then wait at the same
  approval boundary again.
- `--auto`: leave the proposal `approved`; do not wait.

Do not create a second planning artifact or approval stage.

## Output

```text
Proposal: <path>
Status: <draft|approved>
Next: <approve, give feedback, or $implement <proposal>>
```
