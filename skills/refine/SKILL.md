---
name: refine
description: >
  Simplify code + improve comments in uncommitted changes. Use `simplify`
  for read-only blueprint/design simplification reports.
  Triggers: 'refine', 'clean up code', 'simplify changes'.
allowed-tools: Bash, Read, Edit, Glob, Grep
argument-hint: "[file-pattern]"
---

# Refine

Polish uncommitted changes: simplify code, improve comments.

For design documents, blueprints, or plans that should not be edited, use
`/skill:simplify` instead. This skill edits only uncommitted code changes.

## Arguments

- `<file-pattern>` — limit to matching files (glob or path)

## Steps

### 1. Identify Files

- If `$ARGUMENTS`: use as file pattern
- Otherwise: `git diff --name-only` + `git diff --cached --name-only`
- Filter to code files (exclude config, lock, generated)
- No files → inform + exit

### 2. Read Files (parallel)

Read all identified files.

### 3. Analyze + Apply

For each file, find and fix:

**Simplify code** — apply standard simplification patterns
(guard clauses, naming, single-responsibility, etc).

**Improve comments:**
- Remove code-restating comments ("increment counter",
  "loop through items", "return result")
- Remove contextless TODOs
- Keep: why-explanations, edge case warnings, business logic,
  perf constraints
- Update inaccurate/outdated comments (don't remove)

**Doc comments** (JSDoc, docstrings, GoDoc, RustDoc):
- Preserve by default — consumed by tools + IDEs
- Remove only if vacuous (empty, or restates signature with
  zero info)
- If inaccurate → update, don't remove

### 4. Verify

Check syntax after changes (linter/parser). Revert + note
if verification fails.

### 5. Summary

Per file: simplifications applied, comments removed/improved.
Offer `git diff` to review.

## Boundaries

Do NOT:
- Add features or change behavior
- Add error handling or abstractions
- Add comments to unchanged code
- Touch code outside the diff
- Refactor beyond uncommitted changes
- Produce design/blueprint simplification reports; use `simplify` for that
