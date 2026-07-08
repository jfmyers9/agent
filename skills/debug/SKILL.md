---
name: debug
description: >
  Reproduce, diagnose, and fix bugs, CI failures, and test failures. Use when
  the user wants the failure resolved; use diagnose for a read-only durable
  root-cause report.
allowed-tools: Bash, Read, Glob, Grep, Edit, Write
argument-hint: "[error-description|blueprint-slug-or-path]"
---

# Debug

Resolve a failure from reproducible evidence without creating a tracker.

@rules/harness-compat.md applies.

## Workflow

1. Resolve the failure description and read any explicitly named proposal,
   review, report, or legacy blueprint as optional context. Do not search for an
   artifact when none was named.
2. Read applicable repository instructions, inspect the working tree, and
   preserve unrelated changes.
3. Reproduce the failure with the narrowest known command. Capture the exact
   expected behavior, actual behavior, and baseline failures before editing.
4. Trace the relevant control/data flow and recent changes. Form competing
   root-cause hypotheses and falsify them with source evidence or focused
   probes; do not patch a merely correlated symptom.
5. Make the smallest complete root-cause fix. Add or strengthen a regression
   test when it would catch the reported bug, and avoid adjacent refactors.
6. Re-run the original reproducer, the focused regression checks, and broader
   checks warranted by the change's risk.
7. Report the root cause, files changed, commands and results, and any remaining
   uncertainty or risk.

If the failure cannot be reproduced or the cause remains unproven, report the
evidence and the next discriminating check instead of making a speculative
edit. Do not create a blueprint. If the user explicitly requests a durable
diagnosis, use the `diagnose` artifact skill and do not edit source files.
