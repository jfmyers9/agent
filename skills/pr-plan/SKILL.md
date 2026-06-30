---
name: pr-plan
description: >
  Fetch PR review comments, validate them, and return a concise fix/reply plan.
  Use for PR feedback planning without changing code.
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "[pr-number|blueprint-slug-or-path]"
---

# PR Plan

Triage PR feedback and return an actionable plan in chat.

@rules/harness-compat.md applies.

## Workflow

1. Resolve the explicit PR or current branch PR. An explicitly named proposal,
   review, report, or legacy blueprint is optional context.
2. Fetch unresolved review threads, PR reviews/comments, branch diff, and
   commits with bounded output.
3. Skip resolved threads, acknowledgements, author comments, and invalid bot
   nits. Preserve outdated but still relevant requests.
4. Read cited code and classify each item: `agree`, `disagree`, `question`, or
   `already done`.
5. For agreed items, give file-specific changes and verification. For other
   items, draft a concise reply.
6. Return counts, ordered fixes, and reply drafts in chat.

Do not create a blueprint or tracker. Use `$respond` when the user wants the
same triage plus execution/posting decisions.
