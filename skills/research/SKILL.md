---
name: research
description: >
  Research topics, investigate codebases, and create blueprint proposals for
  local review. Triggers: 'research', 'investigate', 'explore'.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<topic or question> | --continue | --discard [slug] | --depth <medium|high|max> | --auto"
---

# Research

Research a topic and write one `spec/` blueprint proposal as the durable
source of truth for implementation. The user reviews blueprints locally and
approves or requests changes in chat.

@rules/blueprints.md, @rules/human-approval.md, and
@rules/harness-compat.md apply.

## Arguments

- `<topic>` - new research topic
- `--continue` - resume the most recent spec blueprint
- `--discard [slug]` - delete the most recent or matching spec
  blueprint
- `--depth <medium|high|max>` - thoroughness, default `medium`
- `--auto` - bypass human approval gates, used by `/skill:vibe`

## Blueprint

Create proposal specs with:

```bash
file=$(blueprint create spec "<topic>" --status spec_review --depth <level>)
```

Specs are staged review artifacts. Optimize for human review before
implementation detail. A reviewer should be able to answer these within two
minutes:

1. What decision is being requested?
2. Why is this recommendation better than alternatives?
3. What is in scope and out of scope?
4. What risks or open questions remain?
5. What observable criteria define success?

At `spec_review`, write only the spec slice:

```markdown
## Review Brief

- Decision needed:
- Recommendation:
- Why:
- Scope:
- Approval unblocks:

## Current State

### Observed Behavior

### Relevant Code

| Area | Path | Notes |
| ---- | ---- | ----- |

### Existing Patterns To Preserve

### Constraints

## Proposed Target State

### Behavior

### Architecture

### Interfaces / Data / Config

### Non-Goals

### Acceptance Criteria

- [ ] <observable result>

## Tradeoffs

### Options Considered

| Option | Pros | Cons | Verdict |
| ------ | ---- | ---- | ------- |

### Risks & Mitigations

| Risk | Mitigation |
| ---- | ---------- |

### Open Questions

- None

## Evidence Appendix

### Source-Backed Claims

| Claim | Evidence |
| ----- | -------- |

### Research Notes

- <brief notes, only when useful>

## Approval History

- <timestamp> - spec approved | revised from user feedback
```

At `plan_review`, append the implementation plan after spec approval:

```markdown
## Implementation Plan

### Phase 1: <name>

- Goal:
- Files:
- Approach:
- Steps:
  1. <action, path, done signal>
- Done:
- Verify:
```

Use frontmatter status for progress:

- `spec_review` - spec slice drafted; awaiting user review
- `spec_approved` - spec slice accepted; plan slice may be drafted
- `plan_review` - plan slice drafted; awaiting user review
- `approved` - proposal ready for `/skill:implement`

Run `blueprint commit spec <slug>` after every blueprint write or
status change. If it fails, stop and show the error.

## Workflow

### 1. Resolve Work

- `--discard`: find via `blueprint find --type spec [--match <slug>]`,
  delete it, run `blueprint commit spec <slug>`, report.
- `--continue`: find the latest spec via `blueprint find --type spec`,
  read it, and resume from frontmatter `status` and the latest user
  response.
- New topic: parse flags, derive topic text, create a new spec
  blueprint.

### 2. Research

Use targeted `bash`/`read` calls. Do not dump broad files or logs.
Keep raw evidence out of the review path unless it directly supports a
claim.

Depth guidance:

- `medium`: key files and architecture, 3-5 implementation phases
- `high`: all relevant files, 2-level call chains, line refs, 5-7
  implementation phases
- `max`: exhaustive affected modules, dependency graph, annotated
  snippets, 7+ implementation phases

Research must identify:

- Current behavior and relevant file paths
- Existing patterns to preserve
- Constraints, risks, and edge cases
- Candidate implementation approach
- Verification commands or checks
- Alternatives considered when there is a meaningful choice

Spot-check at least three architectural claims against source before
writing the spec. Prefer repo-relative paths in blueprint prose. Put dense
path/line references in `## Evidence Appendix` instead of inline prose.

### 3. Write Spec Slice

Write a human-reviewable spec. Put the decision summary first and supporting
evidence later.

The spec must make these easy to answer:

1. What decision is requested?
2. Why is this recommendation better than alternatives?
3. What is in scope and out of scope?
4. What risks or open questions remain?
5. What observable criteria define success?

Use target-state language for behavior and architecture, but do not sacrifice
clarity to avoid verbs like "add", "replace", or "remove". Keep
implementation sequencing in the later plan slice.

Spec section guidance:

- **Review Brief** - five concise bullets for the requested decision,
  recommendation, rationale, scope, and what approval unlocks.
- **Current State** - observed behavior, relevant code, patterns, and
  constraints. Use tables for code/path summaries.
- **Proposed Target State** - desired behavior, architecture,
  interfaces/data/config, non-goals, and acceptance criteria.
- **Tradeoffs** - alternatives, risks with mitigations, and open questions.
- **Evidence Appendix** - source-backed claims and brief research notes.
  Avoid turning this into a raw dump.
- **Approval History** - append status changes or feedback revisions.

Set status to `spec_review`, write the blueprint, and commit. Do not write
`## Implementation Plan` yet unless `--auto` is present.

If `--auto` is absent, stop after reporting:

```text
Spec/Plan: <path>
Status: spec_review
Review: open the blueprint locally and reply with approval or feedback
Next: /skill:research --continue
```

On explicit chat approval, append/update `## Approval History`, set
status to `spec_approved`, commit, and continue to planning.

On feedback, revise only the affected blueprint content, append/update
`## Approval History`, commit, and return to `spec_review`.

If `--auto` is present, set status to `spec_approved`, commit, and
continue without waiting for human approval.

### 4. Write Plan Slice

After spec approval, append `## Implementation Plan` to the same blueprint.
Every phase must include:

- Goal
- Files to read/modify/create
- Approach
- Ordered steps
- Done signal
- Verification

Keep phases tactical and executable. Avoid repeating the spec rationale unless
it changes the implementation order.

Set status to `plan_review`, write the blueprint, and commit.

If `--auto` is absent, stop after reporting:

```text
Spec/Plan: <path>
Status: plan_review
Review: open the blueprint locally and reply with approval or feedback
Next: /skill:research --continue
```

On explicit chat approval, append/update `## Approval History`, set
status to `approved`, and commit.

On feedback, revise only the affected plan/spec content, append/update
`## Approval History`, commit, and return to `plan_review`.

If `--auto` is present, set status to `approved` and commit.

## Output

Keep user-facing output concise:

```text
Spec/Plan: <path>
Status: <status>
Next: <review instruction or /skill:implement>
```
