---
name: debug
description: >
  Reproduce and investigate bugs, test failures, and CI failures, then produce
  an evidence-backed bug report with code pointers and recommended next steps.
  Use for diagnosis before changing code; this skill does not apply fixes.
  Use artifact separately when saving the report is requested.
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "<failure-description> [input-document]"
---

# Debug

Investigate a failure and return a concise bug report in chat. Establish the
cause from evidence before recommending a fix; keep uncertainty explicit.

@rules/context-budget.md and @rules/harness-compat.md apply.

1. Establish expected behavior, actual behavior, affected scope, and the known
   trigger from the conversation. Read an explicitly supplied input document
   as context and recheck its claims. Read repository instructions and inspect
   the working tree so existing changes and baseline failures are understood.
2. Reproduce with the narrowest useful command or probe. Record relevant inputs,
   environment, prerequisites, command, exit result, and a bounded failure
   excerpt. Prefer existing tests and isolated temporary probes; do not modify
   product source or tracked tests to investigate. Keep generated outputs
   separate from user changes and do not run destructive reproductions against
   shared data. Label supplied logs as supplied evidence, not a local run.
3. Trace the relevant control and data flow from the failing boundary through
   callers, state, dependencies, configuration, and tests. Inspect recent
   changes when they help distinguish causes. Cite paths and symbols, with
   line numbers when useful, and connect code observations to the failure.
4. Form plausible competing hypotheses and test them with focused checks.
   Record evidence supporting or contradicting each material explanation.
   Distinguish the triggering condition, underlying cause, and downstream
   symptom; correlation alone does not establish causation. When reproduction
   is unavailable, explain what can still be established from source or logs.
5. Recommend the smallest complete correction only as far as the evidence
   supports it. Identify affected code and a regression scenario that would
   fail before the fix and pass afterward. Do not apply the fix or add tests.
   If the cause remains unproven, report the leading hypotheses and the next
   discriminating check instead of presenting a speculative fix as settled.
6. Return the report below, scaling detail to the failure. Separate observed
   results, inference, and proposed verification. State any reproduction limit
   or evidence gap that materially weakens the conclusion.

## Bug Report Content

- Failure: expected versus actual behavior, trigger, and affected scope.
- Reproduction: inputs, environment, exact steps or command, and observed result.
- Investigation: relevant code path and hypothesis evidence with code pointers.
- Diagnosis: root cause and confidence, or unresolved competing explanations.
- Impact: evidenced consequences and boundaries; label inferred impact.
- Recommendation: proposed correction and meaningful regression verification.
- Open questions: missing evidence and the next check needed to resolve it.

## Handoff

Debug stops with the report without editing source, updating input documents,
staging, committing, or assigning workflow status. A later request to fix the
issue can use the report as context through ordinary implementation prompts;
recheck its assumptions against current code before applying changes.

If saving is explicitly requested, use `$artifact` separately with the report
and requested destination without an additional confirmation. Otherwise keep
the report in chat. Saving does not authorize a fix or create approval state.
