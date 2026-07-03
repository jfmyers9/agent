---
name: improve-rust-tests
description: "Improve Rust test suites with a wide, evidence-grounded pass over placement, coverage, readability, and tooling. Use when the user asks to improve Rust tests, adopt stronger Rust testing practices, add property tests, reorganize unit/integration tests, or modernize a Rust project toward TDD guidance."
user-invocable: true
---

# Improve Rust Tests

Take a wide pass over a Rust project and move its tests toward the Rust testing guidance in the TDD skill. Activate `$tdd` before using this skill if it is not already active, then follow its Rust testing reference. The goal is substantial, behavior-focused improvement, not coverage padding.

## Process

### 1. Establish the baseline

- Read project instructions, Cargo workspace layout, and existing test commands.
- Inspect `Cargo.toml` dev-dependencies before adding any tools.
- Use `sym` first for source navigation when it can answer the question; use `rg` for file/text discovery.
- Run the narrowest useful baseline command: `cargo nextest run` when available, otherwise `cargo test`; include `cargo test --doc` when doctests matter.
- Note existing failures before editing; do not claim them as caused by your changes unless verified.

### 2. Map the current test shape

Classify coverage by placement: `tests/*.rs`, CLI tests, `#[cfg(test)]` module tests, private-helper tests, doctests, snapshots, properties, filesystem tests, and fixture-heavy tests.

Identify bad smells: unit tests dwarf production modules; tests assert getters, constants, or type-system facts; assertions mirror production algorithms; integration tests verify internals; properties lack named invariants; fixtures hide behavior.

### 3. Present improvement candidates

Before editing, present a numbered list of substantial candidates. For each:

- **Files** — tests and production seams involved
- **Problem** — what the current test shape misses or obscures
- **Change** — what would move, be added, deleted, or rewritten
- **Tooling** — whether to use `pretty_assertions`, `rstest`, `proptest`, `assert_cmd`, `tempfile`, `assert_fs`, or `insta`
- **Verification** — the command that should fail before the change or prove it after the change

Ask which candidates to execute unless the user asked for an automatic pass.

### 4. Execute selected improvements

Work vertically. For each selected behavior:

1. State the bug scenario or invariant the test will catch.
2. Choose placement using the Rust TDD placement ladder.
3. Add the smallest test that proves the behavior or property.
4. Confirm RED when changing behavior; for pure test refactors, preserve GREEN.
5. Implement or refactor only enough to satisfy the selected test improvement.
6. Run the narrowest GREEN command.
7. Delete redundant, misleading, or implementation-coupled tests.

Use tools deliberately: `pretty_assertions` for diffs, `rstest` for named cases/fixtures, `proptest` for properties, `assert_cmd` for CLI contracts, `tempfile`/`assert_fs` for filesystem contracts, and `insta` only for existing or explicitly requested snapshots.

### 5. Refactor test organization

When improving placement, prefer integration tests for public crate behavior; keep CLI tests at the executable boundary; keep module tests focused; move oversized unit test modules with `#[cfg(test)] mod foo_tests;`; keep private-helper tests only when clearer than public setup; keep shared helpers small.

### 6. Verify and report

Run the project-appropriate final gate, usually:

```sh
cargo fmt --all -- --check
cargo clippy --all -- -D warnings
cargo nextest run
cargo test --doc
```

Adjust to the project if it uses different workspace commands. Report:

- behaviors/properties now covered
- tests deleted or moved
- dev-dependencies added and why
- commands run and results
- remaining test-suite risks or follow-up candidates
