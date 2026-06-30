---
name: split-commit
description: >
  Repackage a multi-commit branch into clean, tested, vertical commits. Use only
  when branch history needs restructuring.
argument-hint: "[base-branch] [--test='command'] [--auto] [blueprint]"
user-invocable: true
allowed-tools: [Bash, Read, Glob, Grep]
---

# Split Commit

Analyze and repackage branch history without creating a tracker.

@rules/harness-compat.md applies.

## Workflow

1. Resolve base (`gt trunk`, remote default, or `main`) and count commits. For
   zero/one commit, stop and suggest `$commit`.
2. Inspect log, diff, dependencies, and any explicitly named blueprint as
   optional intent context.
3. Propose vertical conventional commits: foundational dependencies first;
   config/locks with consumers; each commit independently testable when
   practical.
4. Unless `--auto`, show the proposed split and wait for approval.
5. After approval, read the git-surgeon instructions before partial staging.
   Collapse to the base, stage by file/hunk, verify, and commit each group.
6. Ensure no changes remain, show the final log, and report tests.

Do not create or update a blueprint. Never rewrite history before approval
unless `--auto` was explicitly supplied.
