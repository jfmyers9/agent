---
name: respond
description: >
  Validate active pull-request review feedback, plan or apply fixes, and post
  evidence-based replies only when authorized. Use for read-only PR feedback
  planning, feedback fixes, and live review-thread responses.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: >
  [pr-number|pr-url] [--plan] [--fix] [--post]
  [blueprint-slug-or-path]
---

# Respond

Validate PR feedback, then plan, fix, or post without crossing the requested
side-effect boundary.

@rules/harness-compat.md and @rules/pr-workflow.md apply.

## Arguments

- `[pr-number|pr-url]` — target PR; default to the current branch's PR
- `--plan` — return a read-only fix and reply plan; this is the default
- `--fix` — apply validated fixes and prepare replies without posting them
- `--post` — post validated replies; does not authorize code edits
- `[blueprint-slug-or-path]` — optional, explicitly named context

The three modes are mutually exclusive. A fix must be committed and pushed by a
separate authorized workflow before `--post` can truthfully describe it as
present on the PR head. Equivalent explicit prose selects the same mode; when
intent is unclear, use `--plan`.

## Workflow

1. Resolve the mode and an explicit PR number or URL, otherwise the current
   branch's PR. Read a blueprint only when the user named it; do not search for
   one.
2. Fetch structured PR metadata, the branch diff and commits, reviews,
   top-level comments, and unresolved review threads. Bound queries at their
   source and report authentication/API failures instead of silently omitting
   feedback.
3. Normalize and deduplicate feedback. Exclude resolved threads and pure
   acknowledgements; retain author replies as context and outdated comments
   that still apply. Validate substantive bot findings rather than dismissing
   them by source.
4. Read the cited code and relevant tests, then classify each request as
   `agree`, `disagree`, `question`, or `already done` against the current PR
   head. Base the decision on code and evidence, not reviewer authority or
   stale line numbers.
5. Build one decision set. For each agreed item, include the thread reference,
   evidence, exact file-level change, dependencies, and verification. For every
   other classification, include the evidence that supports the reply. Order
   fixes by dependency and risk, and list duplicate requests once while
   retaining every relevant thread link.
6. In fix mode, require the current worktree to be on the PR head branch and
   inspect `git status --short` before editing. Preserve unrelated user changes;
   do not switch branches, overwrite them, or fold them into the fix. Apply the
   smallest coherent changes for agreed items and run focused verification. In
   plan or post-only mode, do not edit files. Never make speculative changes for
   disagreements or unanswered questions.
7. Draft a concise reply for each actionable thread:
   - For an applied fix, state the outcome and verification without overselling.
   - For a disagreement, cite concrete code or compatibility evidence.
   - For a question, ask only for the decision that blocks progress.
   - For `already done`, point to the current code or commit.
8. In post mode, post only replies whose claims are established by the current
   remote PR head and verification. If a fix exists only in the local worktree,
   stop and report that it must be committed and pushed separately. `--post`
   authorizes replies, not resolving threads; resolve a thread only when the
   user separately requests that GitHub action and its outcome is established.
   Never infer posting permission from a request to draft, fix, or address
   feedback.
9. Report classification totals, ordered fixes, changed files, checks run,
   remaining decisions, and reply drafts or posted-reply links.

Do not create a blueprint/tracker, commit, submit, force-push, or close a PR in
this workflow. Prefer fixing valid comments over debating them, and do not enter
repetitive bot style loops without a human decision.
