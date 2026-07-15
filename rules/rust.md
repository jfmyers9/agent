---
paths:
  - "**/*.rs"
---

# Rust

## Toolchain

Use the repository's pinned toolchain, edition, and minimum supported Rust
version. Do not upgrade them unless the requested change requires it.

## Zero Warnings

- Run the repository's configured Clippy command after Rust changes. Default to
  `cargo clippy --workspace --all-targets -- -D warnings` when none exists.
- Introduce no new warnings. Report unrelated baseline warnings separately.
- Never write code that will obviously warn (empty enums making types uninhabited, unused variables, dead code) and rationalize it as "expected" or "will go away later"
- If a construct warns without content, use a simpler construct that doesn't (e.g. flat struct instead of struct+empty enum)
- Avoid `#[allow(...)]` unless DIRECTLY instructed by user

## Validation

Run the narrowest relevant checks first, then the repository's required final
checks. Typical final checks are:

1. `cargo fmt --all -- --check`
2. `cargo clippy --workspace --all-targets -- -D warnings`
3. `cargo test --workspace`
4. `cargo build --workspace`

## Dead Code

Remove immediately. Use `#[cfg(test)]` for test-only.

## Imports

All `use` at file top. No inline imports.

## Dependencies

Never assume crate versions from training data. Inspect the lockfile, workspace
dependencies, MSRV, and crate metadata before selecting a compatible version.
Prefer an existing workspace dependency. Do not upgrade to the latest release
merely because it exists.

## Test Organization

Follow the crate's existing test layout. Inline `mod tests {}` is appropriate
for small private-behavior suites; extract it when size or navigation cost
materially hurts readability.

- **Single-file module** — use `#[path]` sibling file:
  ```rust
  #[cfg(test)]
  #[path = "foo_tests.rs"]
  mod tests;
  ```
- **Directory module** (`foo/mod.rs`) — use `foo/tests.rs`

When extracting, pick one convention per crate. `#[path]` is often less
disruptive for a single-file module.

### Migration

- Split incrementally when the touched test module has become difficult to
  navigate; line count is a signal, not a threshold
- `use super::*` at top of new file for private access
- Move test helpers with the tests; keep `#[cfg(test)]` helpers
  that live outside the test module in the source file
- Explicitly add test-only deps (`use pretty_assertions::assert_eq`, etc.)
