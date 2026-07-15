---
name: improve-rust-tests
description: >
  Improve a Rust test suite's behavior coverage, placement, readability, and
  tooling. Use when asked to strengthen Rust tests, add properties, reorganize
  unit or integration tests, or modernize testing practices.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
user-invocable: true
---

# Improve Rust Tests

Strengthen tests around realistic bugs and public behavior without padding
coverage or coupling tests to implementation details.

@rules/test-quality.md, @rules/rust.md, and @rules/harness-compat.md apply.

## Workflow

### 1. Establish Scope And Baseline

- Read repository instructions, the Cargo workspace layout, pinned toolchain or
  MSRV, test configuration, and current dev-dependencies.
- Inspect the working tree and preserve unrelated changes.
- Discover source and tests with `rg`; use optional navigation tools only when
  they are available and provide a documented fallback.
- Run the narrowest project-standard baseline test command. Use Cargo's built-in
  test command when no runner is configured.
- Record pre-existing failures before editing. Do not attribute them to the
  change without reproducing that causality.

### 2. Map The Test Suite

Inventory integration tests, CLI tests, sibling unit-test files, doctests,
properties, snapshots, filesystem tests, fixtures, and shared helpers. Trace
important public behaviors and failure boundaries to their current coverage.

Look for evidence-backed improvement opportunities:

- missing boundary, error, state-transition, ordering, or integration cases;
- tautologies, getter tests, type-system facts, and coverage-only execution;
- assertions that duplicate the production algorithm;
- tests coupled to private structure when a public contract is clearer;
- test placement that conflicts with the crate's established convention;
- unnamed properties, opaque fixtures, brittle snapshots, and excessive mocks;
  and
- slow duplicated setup or nondeterministic filesystem, clock, or concurrency
  behavior.

Every proposed test must name the realistic bug, contract, or invariant it
would protect. Apply the deletion heuristic from `@rules/test-quality.md`
without removing deliberate cross-layer coverage.

### 3. Select The Work

Choose the smallest coherent set of high-confidence improvements. Briefly state
the selected behaviors and verification before editing. Continue without an
approval round when they stay within the requested test scope.

Ask before proceeding only when alternatives materially change public behavior,
require a new production seam or dependency, or expand beyond the requested
scope. Explain that decision with the concrete tradeoff.

### 4. Implement Vertically

For each selected behavior:

1. State the bug scenario or invariant.
2. Choose the narrowest placement that tests the right contract.
3. Add or refactor the smallest meaningful test.
4. Demonstrate RED when fixing an existing bug or changing behavior. Preserve
   GREEN for organization-only refactors and new coverage of correct behavior;
   never break production code merely to manufacture RED.
5. Change production code only when explicitly authorized by the request. Stop
   before adding a new test seam that changes production structure.
6. Run the focused test, then the required Clippy check for the implementation
   slice.
7. Delete tests made redundant, misleading, or implementation-coupled.

Prefer real owned collaborators. Mock external or nondeterministic boundaries
such as networks, clocks, and third-party services. Several mocks are a signal
to reassess the seam, not an automatic reason to redesign production code.

### 5. Place Tests Deliberately

- Put public crate behavior in `tests/*.rs` when it needs only public APIs.
- Test executable contracts at the CLI boundary.
- Keep private-behavior tests beside their module using the crate's established
  inline, sibling, or directory convention. Extract large inline suites only
  when doing so materially improves navigation.
- Use doctests for stable user-facing examples, not internal edge cases.
- Keep shared helpers small, explicit, and behavior-neutral.

Avoid reorganizing unaffected tests merely to impose a preferred layout.

### 6. Select Tooling Conservatively

Use `pretty_assertions` for materially clearer diffs, `rstest` for genuinely
shared named cases or fixtures, `proptest` for named invariants over broad input
spaces, `assert_cmd` for CLI contracts, and `tempfile` or `assert_fs` for
filesystem boundaries. Use `insta` only when snapshots already form part of the
contract or the user explicitly requested them.

Before adding a crate, inspect workspace dependencies, the lockfile, MSRV, and
current crate metadata. Select a compatible version rather than automatically
choosing the newest release. Avoid overlapping tools and remove a dependency
when its last use disappears.

### 7. Verify And Report

Format only files changed by this workflow while editing. Do not run a mutating
workspace-wide formatter when unrelated dirty Rust files exist. Use the
repository's configured feature sets and final checks. When none are defined,
finish with the defaults in `@rules/rust.md`.

Run the configured nextest command as well when the project standardizes on it.
Do not hide warnings with `#[allow(...)]`. Report behaviors and properties now
covered, tests moved or deleted, dependencies changed and why, commands and
results, pre-existing failures, and remaining test-suite risks.
