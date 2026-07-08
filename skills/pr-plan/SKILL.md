---
name: pr-plan
description: >
  Read and validate pull-request review feedback, then return a concise fix and
  reply plan without changing code or GitHub state. Use for PR feedback planning.
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "[pr-number|pr-url] [blueprint-slug-or-path]"
---

# PR Plan

Turn live PR feedback into an evidence-backed action plan in chat.

@rules/harness-compat.md applies.

## Arguments

- `[pr-number|pr-url]` — target PR; default to the current branch's PR
- `[blueprint-slug-or-path]` — optional, explicitly named context

## Workflow

1. Resolve an explicit PR number or URL, otherwise the current branch's PR.
   Read a blueprint only when the user named it; do not search for one.
2. Fetch structured PR metadata, the branch diff and commits, reviews,
   top-level comments, and unresolved review threads. Bound queries at their
   source and surface authentication/API failures instead of treating them as
   empty results.
3. Normalize and deduplicate feedback by thread or underlying request. Exclude
   resolved threads and pure acknowledgements. Keep author replies as context,
   keep outdated comments that still apply, and validate substantive bot
   findings before dismissing them.
4. Read the cited code and enough surrounding implementation/tests to classify
   each request as `agree`, `disagree`, `question`, or `already done`. Base the
   classification on current code, not reviewer authority or stale line numbers.
5. For each agreed item, give the thread reference, evidence, exact file-level
   change, dependencies, and verification. For every other classification,
   draft a short evidence-based reply.
6. Return totals by classification, then order fixes by dependency and risk.
   Note duplicate requests once while retaining all relevant thread links.

Do not edit files, post replies, resolve threads, commit, submit, or create a
blueprint/tracker. Use `$respond` when the user wants validated fixes applied or
GitHub reply decisions prepared for execution.
