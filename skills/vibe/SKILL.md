---
name: vibe
description: >
  Run an explicitly requested autonomous code-change workflow through research,
  implementation, review, fixes, commit, and Graphite submission.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<prompt> [--dry-run] [blueprint-slug-or-path]"
---

# Vibe

Deliver an explicitly scoped change end to end without a pipeline tracker.

@rules/harness-compat.md applies.

## Pipeline

1. Parse the prompt, `--dry-run`, and any explicitly named artifact. With
   `--dry-run`, perform read-only inspection and return the proposed scope,
   approach, risks, and checks; do not edit files, create artifacts or branches,
   commit, or submit.
2. Read repository instructions and inspect the working tree and Graphite
   stack. Require a clean baseline before execution because the final submit
   also requires one; do not stash or absorb unrelated work. When execution
   starts on trunk, derive a concise task branch name and follow `start` before
   editing.
3. Research uncertain implementation details in-session. Follow
   `$research --auto` only when the user explicitly requests a durable proposal;
   otherwise do not create one. Treat existing blueprints as optional inputs.
4. Follow `implement` for the requested work and its acceptance checks.
5. Review the complete diff in-session for correctness and compatibility,
   security and reliability, tests, and design and maintainability. Follow the
   explicit `review` artifact skill only when the user requested a durable
   review.
6. Revalidate and fix actionable findings with the `fix` loop. Update the
   resolution table when a review artifact exists, then re-review affected
   areas.
7. Run the repository's final checks. Do not commit or submit with known
   relevant failures.
8. Stage only paths created, changed, or deleted by this scoped run, including
   its new files. Follow `commit` to create conventional commits, verify the
   tree is clean, then follow `submit` to restack the Graphite stack and create
   or update the PR.

Do not create a pipeline tracker. Generate an execution report only when the
user explicitly includes `$report`.

On success, return the change, checks, commits, and PR. On a blocking failure,
return the completed stage, evidence, preserved work, and exact command or
decision needed to continue.
