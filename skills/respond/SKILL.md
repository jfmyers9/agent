---
name: respond
description: >
  Triage PR review feedback, recommend code actions, and draft concise replies.
  Use for active PR feedback handling.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[pr-number|blueprint-slug-or-path]"
---

# Respond

Validate PR feedback, apply authorized fixes when requested, and draft replies.

@rules/harness-compat.md applies.

## Workflow

1. Resolve the explicit PR or current branch PR. Read an explicitly named
   blueprint only as optional context.
2. Fetch unresolved threads, PR context, diff, and commits with bounded output.
3. Read cited code; classify each item as `agree`, `disagree`, `question`, or
   `already done`.
4. Revalidate agreed findings. If the user asked to address feedback, apply the
   smallest fixes and verify them; otherwise return a fix plan.
5. Draft concise replies for disagreements, questions, and already-completed
   items. Do not post replies unless explicitly authorized.
6. Report classifications, changes/tests, and reply drafts.

Do not create a blueprint or tracker. Prefer fixing valid comments over
debating them; ignore bot style loops unless a human decision is needed.
