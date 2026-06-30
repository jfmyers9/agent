---
name: vibe
description: >
  Run an explicitly requested autonomous development workflow from prompt to
  review, fixes, commit, and submit.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "<prompt> [--dry-run] [blueprint-slug-or-path]"
---

# Vibe

Run the development pipeline autonomously without a tracker artifact.

@rules/harness-compat.md applies.

## Pipeline

1. Inspect the request and any explicitly named blueprint. Use `$research
   --auto` only when the user explicitly requests a durable proposal; otherwise
   research directly in-session.
2. Follow `implement` for the requested work.
3. Follow `review` only when the user explicitly requests its durable review
   artifact; otherwise run the same core lenses in-session.
4. Revalidate and fix actionable findings using the `fix` loop. If a review
   artifact exists, update its resolution table.
5. Run final checks.
6. Follow `commit`, then `submit`.

`--dry-run` stops after in-session research and returns the proposed approach.
Do not create a pipeline tracker. Generate an execution report only when the
user explicitly includes `$report`. Existing blueprints are optional inputs,
not stage requirements.

On a blocking failure, report the completed stage, error, preserved work, and
the exact command/decision needed to continue.
