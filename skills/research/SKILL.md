---
name: research
description: >
  Explore a codebase and develop a cohesive, reviewable plan for a feature,
  behavior change, or architectural decision. Use when the user wants code
  pointers, interface design, layering, tradeoffs, and implementation steps
  before editing code. Use artifact separately when saving is requested.
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "<change-or-design-question> [input-document]"
---

# Research

Produce a code-grounded design and implementation plan in chat. Scale depth to
the change; a small task needs a short plan, not a full design document.

@rules/context-budget.md and @rules/harness-compat.md apply.

1. Establish the requested behavior, constraints, non-goals, and observable
   acceptance criteria from the conversation. Read an explicitly supplied
   input document as context; do not search for an unnamed plan. Ask about
   missing decisions that materially affect the design while continuing
   exploration that does not depend on the answer.
2. Read applicable repository instructions and inspect the working tree.
   Trace relevant entrypoints, callers, types, ownership boundaries, and tests.
   Follow enough of the control and data flow to substantiate the design.
   Identify existing patterns to reuse and constraints the change must respect.
   Cite concrete file paths and symbols, with line numbers when useful.
3. Develop a cohesive recommendation. Explain interface contracts, which layer
   owns each responsibility, dependencies, data flow, and relevant error or
   compatibility behavior. Cover only dimensions the task touches. Compare
   meaningful alternatives where they affect the decision and explain the
   preferred approach; avoid speculative abstractions or unrelated cleanup.
4. Break the design into ordered, cohesive implementation steps. Tie each step
   to affected files or symbols, its intended behavior, and dependencies on
   earlier steps. Name proposed new interfaces explicitly as proposals. Include
   verification that protects acceptance criteria and important failure
   boundaries, using existing tests and commands where available.
5. Return the plan using the outline below, combining or omitting sections when
   appropriate. Separate confirmed code facts from assumptions and unresolved
   questions. Do not claim checks passed unless run; distinguish proposed
   verification from exploration already performed.

## Plan Content

- Goal and boundaries: behavior, constraints, non-goals, acceptance criteria.
- Current code: relevant paths, symbols, flows, patterns, and limitations.
- Proposed design: interfaces, responsibilities, layering, and tradeoffs.
- Implementation steps: ordered changes with concrete code pointers.
- Verification: behavior to test and relevant checks.
- Open decisions: material questions, recommendations, and evidence gaps.

## Handoff

A planning-only request ends with the plan for the user's review. Refine it in
conversation when requested. When the user also authorizes implementation,
continue under that instruction without adding an approval gate; recheck code
pointers and assumptions before editing and report material deviations.

Research does not edit source, save documents, update input documents, stage,
commit, or assign workflow status. If saving is explicitly requested, use
`$artifact` separately with the agreed plan and requested destination. A saved
plan carries context, not workflow state; it is never an implementation
prerequisite.
