---
name: resume-work
description: >
  Summarize branch, PR, CI, review, and working-tree state after a break, then
  recommend the next action.
allowed-tools: Bash, Read, Glob
argument-hint: "[branch-name|PR#]"
---

# Resume Work

Reconstruct current work from git and PR state. Blueprints are optional context.

@rules/harness-compat.md applies.

## Workflow

1. Resolve current branch, an explicit branch, or a PR's head branch.
2. Gather bounded branch log/status, PR metadata, CI checks, and unresolved
   comments.
3. If relevant artifacts exist, optionally run
   `blueprint find --type proposal,review,report,spec,plan`; absence is normal.
4. Summarize branch, recent commits, PR/review/CI, working tree, and only
   relevant artifact state.
5. Recommend the first applicable action: fix CI; address review; implement an
   explicitly relevant approved proposal; review/commit dirty completed work;
   ready/submit PR; or wait.

Do not create or update a blueprint. Prefer live git/PR evidence over stale
artifact state.
