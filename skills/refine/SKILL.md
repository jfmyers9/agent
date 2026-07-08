---
name: refine
description: >
  Simplify code and improve comments only within uncommitted code changes. Use
  for requests to refine, clean up, or simplify the current diff; use simplify
  for a read-only design or blueprint simplification report.
allowed-tools: Bash, Read, Edit, Glob, Grep
argument-hint: "[file-pattern]"
---

# Refine

Improve the clarity of uncommitted code without changing behavior or expanding
scope.

## Arguments

- `[file-pattern]` — optional path or glob limiting the changed files to refine.

## Workflow

### 1. Identify Eligible Hunks

Read repository instructions and inspect `git status --short`, staged and
unstaged diffs, and relevant untracked code files. If a pattern was supplied,
intersect it with those changes. Exclude generated, vendored, lock, and
configuration files unless the user explicitly included them.

Operate only on code lines already changed and the minimum surrounding code
needed to keep the edit coherent. Do not treat an entire changed file as
authorized refactor scope. If no eligible hunks remain, report that and stop.

### 2. Read Context

Read each eligible diff plus enough callers, types, and tests to preserve its
behavior. Batch independent reads when supported, but do not load entire large
files when targeted ranges answer the question.

### 3. Simplify Code

Apply only clear, local improvements such as:

- flattening needless nesting with guard clauses;
- replacing duplicated local logic with an existing nearby helper;
- choosing names that expose intent;
- removing dead code introduced by the current change; and
- reducing accidental complexity without adding an abstraction.

Keep public APIs, error behavior, ordering, performance constraints, and side
effects unchanged. Do not add features, migrations, compatibility shims, error
handling, dependencies, or speculative extensibility.

### 4. Improve Comments

- Remove comments that merely narrate syntax or repeat the code.
- Remove contextless TODOs introduced by the change.
- Preserve explanations of intent, business rules, edge cases, invariants,
  security constraints, and non-obvious performance decisions.
- Update inaccurate comments instead of deleting useful context.
- Preserve doc comments by default because tools and IDEs consume them. Remove
  one only when it is empty or adds nothing beyond the signature.
- Do not add comments to unchanged code.

### 5. Verify

Inspect the refined diff to confirm every edit stays within scope and remains
behavior-preserving. Run the narrowest relevant formatter, parser, linter, type
check, or test. Use a formatter only when it can stay within scope, and remove
any unrelated formatting churn. If verification fails because of a refinement,
correct it or revert only that refinement edit; never discard the user's
pre-existing hunk.

### 6. Report

Return the files and simplifications, comment changes, and verification results.
Do not stage, commit, or create a blueprint.

For a design document, blueprint, or plan that should remain unchanged, use the
explicit `simplify` artifact skill instead.
