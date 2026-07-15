---
name: refine
description: >
  Simplify code and improve comments only within uncommitted code changes. Use
  for requests to refine, clean up, or simplify the current diff; use research
  feedback to simplify a durable proposal.
allowed-tools: Bash, Read, Edit, Glob, Grep
argument-hint: "[file-pattern]"
---

# Refine

Improve the clarity of uncommitted code without changing behavior or expanding
scope.

@rules/comment-quality.md and @rules/style.md apply.

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

Apply `@rules/comment-quality.md` only within eligible hunks. Preserve useful
doc comments and update inaccurate explanations rather than deleting context.
Do not add comments to unchanged code.

### 5. Verify

Inspect the refined diff to confirm every edit stays within scope and remains
behavior-preserving. Run the narrowest relevant formatter, parser, linter, type
check, or test. Use a formatter only when it can stay within scope, and remove
any unrelated formatting churn. If verification fails because of a refinement,
correct it or revert only that refinement edit; never discard the user's
pre-existing hunk.

When refining a staged hunk, leave the refinement unstaged and report the
index/worktree divergence. Do not silently rewrite the user's staged snapshot.

### 6. Report

Return the files and simplifications, comment changes, and verification results.
Do not stage, commit, or create a blueprint.

For a durable proposal, use `$research --continue` so simplification feedback
updates the same source of truth. Review other design documents in chat unless
the user explicitly requests a durable proposal.
