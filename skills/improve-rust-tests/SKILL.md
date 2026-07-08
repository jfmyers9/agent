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

- Read repository instructions, the Cargo workspace layout, toolchain files,
  test configuration, and current dev-dependencies.
- Inspect the working tree and preserve unrelated changes.
- Discover source and tests with `rg`; use optional navigation tools only when
  they are available and provide a documented fallback.
- Run the narrowest project-standard baseline test command. Use Cargo's built-in
  test command when no project runner is configured, and include doctests when
  the selected runner omits them.
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
- oversized or inline test modules that violate `@rules/rust.md`;
- unnamed properties, opaque fixtures, brittle snapshots, and excessive mocks;
  and
- slow duplicated setup or nondeterministic filesystem, clock, or concurrency
  behavior.

Every proposed test must name the realistic bug or invariant it would protect.
Apply the deletion test from `@rules/test-quality.md` and remove redundant tests.

### 3. Present Candidates

Before editing, present a numbered list of substantial candidates. For each,
include:

- files and behavior involved;
- the concrete coverage or readability problem;
- tests to add, move, rewrite, or delete;
- production seams, if any, that must change;
- optional tooling and why it earns its dependency cost; and
- the focused and final verification commands.

Proceed immediately when the user requested an automatic pass or already chose
candidates. Otherwise ask which numbered candidates to implement.

### 4. Implement Vertically

For each selected behavior:

1. State the bug scenario or invariant.
2. Choose the narrowest placement that tests the right contract.
3. Add or refactor the smallest meaningful test.
4. Demonstrate RED when fixing an existing bug or changing behavior. Preserve
   GREEN for organization-only refactors and new coverage of correct behavior;
   never break production code merely to manufacture RED.
5. Change production code only when required by the selected behavior or a
   necessary test seam.
6. Run the focused test, then the required Clippy check for the implementation
   slice.
7. Delete tests made redundant, misleading, or implementation-coupled.

Use real owned collaborators. Mock only external boundaries such as networks,
clocks, and third-party services. Three or more mocks usually indicate a design
seam worth simplifying before adding more tests.

### 5. Place Tests Deliberately

- Put public crate behavior in `tests/*.rs` when it needs only public APIs.
- Test executable contracts at the CLI boundary.
- Keep private-behavior tests beside their module but in separate files, using
  the sibling or directory convention required by `@rules/rust.md`. Do not add
  inline `mod tests { ... }` bodies.
- Use doctests for stable user-facing examples, not internal edge cases.
- Keep shared helpers small, explicit, and behavior-neutral.

When touching an inline module, extract it incrementally. Proactively split
test bodies over roughly 200 lines and use one convention consistently per
crate.

### 6. Select Tooling Conservatively

Use `pretty_assertions` for materially clearer diffs, `rstest` for genuinely
shared named cases or fixtures, `proptest` for named invariants over broad input
spaces, `assert_cmd` for CLI contracts, and `tempfile` or `assert_fs` for
filesystem boundaries. Use `insta` only when snapshots already form part of the
contract or the user explicitly requested them.

Before adding a crate, inspect existing dependencies and use `cargo search` to
verify the current version as required by `@rules/rust.md`. Avoid overlapping
tools and remove a dependency when its last use disappears.

### 7. Verify And Report

Format only files changed by this workflow while editing. Do not run a
mutating workspace-wide formatter when unrelated dirty Rust files exist. Use
the repository's configured feature sets and commands; enable all features
only when the project supports that combination. Unless project instructions
require a different equivalent, finish with:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- \
  -D warnings -W clippy::all
cargo test --workspace
cargo build --workspace
```

Run the configured nextest command as well when the project standardizes on it.
Do not hide warnings with `#[allow(...)]`. Report behaviors and properties now
covered, tests moved or deleted, dependencies changed and why, commands and
results, pre-existing failures, and remaining test-suite risks.
