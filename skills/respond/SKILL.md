---
name: respond
description: >
  Fetch and evaluate pull-request review feedback, apply requested fixes, and
  draft or post evidence-based replies. Use for active PR review threads;
  posting requires explicit authorization.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[pr-number|pr-url] [instructions] [artifact-path]"
---

# Respond

Address PR feedback using current code and review-thread evidence.

@rules/pr-workflow.md applies.

Use the requested PR number or URL, otherwise the current branch's PR. Follow
conversation instructions for the desired actions: assess, fix, commit, push,
or reply. Carry out authorized actions together without requiring separate
invocations. If no action was specified, assess feedback and draft replies.
Read a supplied artifact path as context; do not update it.

1. Fetch structured PR metadata, diff and commits, reviews, top-level comments,
   and unresolved review threads. Bound queries and report API or authentication
   failures instead of silently omitting feedback.
2. Deduplicate requests while retaining thread links and author replies. Skip
   resolved threads and pure acknowledgements; retain outdated comments that
   still apply. Evaluate substantive bot findings on their merits.
3. Read cited code, callers, and relevant tests against the current PR head.
   Classify requests as agreed, disagreed, unclear, or already addressed, with
   evidence. Revalidate stale line references before deciding what to change.
4. When fixes are requested, use a worktree for the PR branch and inspect its
   status before editing. Preserve unrelated changes. Apply valid corrections,
   run focused checks, and inspect the resulting diff. Do not make speculative
   changes for disagreements or unresolved questions. Commit and push when
   authorized by the conversation, following the repository's workflow.
5. Draft concise replies: describe an applied fix and its verification, cite
   code or compatibility evidence for a disagreement, ask the decision needed
   for an unclear request, or link current code for an already addressed item.
6. Post only when explicitly authorized. Refresh the remote PR head and ensure
   every claim about a landed fix matches that head and the verification
   evidence. If the fix is still local, complete an authorized commit/push or
   report the remaining action; do not claim it is on the PR. Posting permission
   does not imply permission to resolve threads. Resolve them only when
   requested and supported by the result. A request to draft, fix, or address
   feedback alone does not authorize posting.
7. Report fixes, verification, unresolved decisions, and reply drafts or posted
   links. Avoid repetitive debates over bot style suggestions; state the
   remaining disagreement with evidence.
