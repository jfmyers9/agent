---
name: debug
description: >
  Diagnose and fix bugs, CI failures, and test failures. Use diagnose instead
  when the user requests a read-only durable root-cause report.
allowed-tools: Bash, Read, Glob, Grep, Edit, Write
argument-hint: "[error-description|blueprint-slug-or-path]"
---

# Debug

Reproduce, diagnose, fix, and verify a failure without requiring a tracker.

@rules/harness-compat.md applies.

## Workflow

1. Resolve input. Use the error description directly, or read an explicitly
   named proposal, review, report, or legacy blueprint as optional context.
2. Inspect branch state and run the narrow failing check when known.
3. Trace expected versus actual behavior, relevant state/data flow, recent
   changes, and competing root-cause hypotheses.
4. Make the smallest root-cause fix; avoid adjacent refactors.
5. Re-run the failing check, then relevant regression checks.
6. Report root cause, files changed, verification, and remaining risks.

Do not create a blueprint. If the user asks only for diagnosis, invoke the
manual `diagnose` artifact skill instead.
