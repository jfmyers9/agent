---
name: resume-work
description: >
  Reconstruct live branch, PR, CI, review, and worktree state after a break and
  recommend the next action without changing state.
allowed-tools: Bash, Read, Glob
argument-hint: "[branch-name|pr-number|pr-url] [blueprint-slug-or-path]"
---

# Resume Work

Give a concise, evidence-backed handoff for the current workstream.

@rules/harness-compat.md applies.

## Arguments

- `[branch-name|pr-number|pr-url]` — target workstream; default to the current
  branch and its PR, if any
- `[blueprint-slug-or-path]` — optional, explicitly named context

## Workflow

1. Resolve the target branch or PR without checking it out. When a different
   branch is requested, keep its state distinct from the current worktree state.
2. Gather bounded live evidence: branch/trunk relationship, recent commits,
   diff summary, upstream divergence, worktree status, PR metadata, CI checks,
   review decision, and unresolved review threads. If remote or GitHub data
   cannot be refreshed, label it unavailable or stale rather than reporting an
   empty result.
3. Read a proposal, review, report, or legacy artifact only when the user
   supplied its slug/path. Do not run broad `blueprint find` discovery. Treat
   artifact content as context and prefer current Git/PR evidence when they
   disagree.
4. Summarize only decision-relevant state: target and parent, recent commits,
   remaining diff/worktree changes, PR/review/CI status, unresolved requests,
   and explicitly supplied artifact status.
5. Recommend the first applicable next action:
   - fix failing CI;
   - address valid unresolved review feedback;
   - finish incomplete implementation or tests;
   - inspect and commit a coherent dirty worktree;
   - push or submit only when explicitly requested, using raw `git push` for
     generic push requests and `$submit` for explicit Graphite/stack submission;
   - wait when an external review or check is the only blocker.

Do not edit files, switch branches, post comments, submit PRs, or create/update
a blueprint. This skill reports state and recommends one next action only.
