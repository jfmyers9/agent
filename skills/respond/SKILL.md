---
name: respond
description: >
  Validate active pull-request review feedback, apply fixes when explicitly
  requested, and prepare concise evidence-based replies. Use for handling live
  PR feedback, not for a read-only review plan.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[pr-number|pr-url] [blueprint-slug-or-path]"
---

# Respond

Resolve valid PR feedback in code and prepare accurate reviewer replies.

@rules/harness-compat.md applies.

## Arguments

- `[pr-number|pr-url]` — target PR; default to the current branch's PR
- `[blueprint-slug-or-path]` — optional, explicitly named context

## Workflow

1. Resolve an explicit PR number or URL, otherwise the current branch's PR.
   Read a blueprint only when the user named it; do not search for one.
2. Fetch structured PR metadata, the branch diff and commits, reviews,
   top-level comments, and unresolved review threads. Bound queries at their
   source and report authentication/API failures instead of silently omitting
   feedback.
3. Normalize and deduplicate feedback. Exclude resolved threads and pure
   acknowledgements; retain author replies as context and outdated comments
   that still apply. Validate substantive bot findings rather than dismissing
   them by source.
4. Read the cited code and relevant tests, then classify each request as
   `agree`, `disagree`, `question`, or `already done` against the current tree.
5. Before editing, require the current worktree to be on the PR head branch and
   inspect `git status --short`. Preserve unrelated user changes; do not switch
   branches, overwrite them, or fold them into a feedback fix implicitly.
6. If the user explicitly asked to fix or address feedback, apply the smallest
   coherent fixes for agreed items and run focused verification. Otherwise,
   return file-specific actions without editing. Do not make speculative
   changes for disagreements or unanswered questions.
7. Draft a concise reply for each actionable thread:
   - For an applied fix, state the outcome and verification without overselling.
   - For a disagreement, cite concrete code or compatibility evidence.
   - For a question, ask only for the decision that blocks progress.
   - For `already done`, point to the current code or commit.
8. Post replies or resolve review threads only when the user explicitly asks
   for those GitHub actions. Never infer posting permission from a request to
   draft, fix, address, or respond to feedback.
9. Report classification totals, changed files, checks run, remaining decisions,
   and reply drafts or posted-reply links.

Do not create a blueprint/tracker, commit, submit, force-push, or close a PR in
this workflow. Prefer fixing valid comments over debating them, and do not enter
repetitive bot style loops without a human decision.
