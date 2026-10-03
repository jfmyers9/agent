---
name: context
description: >
  Explore and explain an unfamiliar codebase, subsystem, feature, or code path
  with an evidence-backed map of entrypoints, responsibilities, interfaces,
  data flow, and tests. Use for understanding existing code; use research for
  planning changes and artifact separately when saving is requested.
  Invoke only as /skill:context or $context.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "<scope-or-question> [input-document]"
---

# Context

Build a useful mental map of existing code and explain it in chat. Scale depth
to the question: start with orientation, then follow the paths needed to answer
it rather than inventorying every file.

@rules/context-budget.md and @rules/harness-compat.md apply.

1. Identify the requested scope: repository, subsystem, feature, path, symbol,
   or behavior. Read explicitly supplied input documents as leads to recheck,
   not authoritative descriptions of current code. For a broad unfamiliar
   repository, begin with its purpose, main components, and entrypoints; narrow
   further exploration to the user's question. State material exclusions.
2. Read applicable repository instructions and inspect the working tree.
   Find definitions and references before reading large files. Inspect relevant
   manifests, configuration, documentation, and tests to orient the search,
   then verify material architecture claims against source.
3. Trace representative behavior from its entrypoint through orchestration,
   state transformations, side effects, and output. Explain which modules and
   layers own each responsibility, their dependency direction, and the
   interfaces between them. Follow relevant error paths and external boundaries
   when needed to understand the behavior; avoid disconnected symbol lists.
4. Identify important invariants, configuration switches, extension points,
   and sharp edges. Locate representative tests and useful verification
   commands. Distinguish commands discovered from checks actually run; source
   presence alone does not prove runtime reachability or deployment.
5. Return a concise explanation using the content below as appropriate. Cite
   concrete paths and symbols, with line numbers when useful, so the user can
   navigate the code. Separate confirmed facts from inference and unknowns.
   For an unresolved question, name the next check that would resolve it.

## Explanation Content

- Orientation: purpose, scope, main components, and a suggested reading order.
- Ownership and interfaces: modules, layers, dependencies, state, and contracts.
- Important flows: representative paths from input through effects to output.
- Constraints and sharp edges: invariants, configuration, and failure behavior.
- Tests and checks: where behavior is covered and how to verify it.
- Open questions: evidence gaps and useful next exploration.

Use a small diagram when it clarifies relationships across boundaries, and
connect its nodes to code pointers. Prefer a focused explanation over a full
repository catalog; expand particular areas when the user asks.

## Handoff

Context explores existing behavior without editing source, saving documents,
updating input documents, staging, committing, or assigning workflow status.
Keep change proposals separate from observations; use `$research` when the user
requests a design or implementation plan. If saving is explicitly requested,
use `$artifact` separately with the explanation and requested destination.
Saved maps are optional context, not trackers; recheck their claims against
current code before relying on them in later work.
