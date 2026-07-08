---
name: archive
description: >
  Move one durable blueprint to the archive and commit the move. Invoke only as
  /skill:archive or $archive.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Glob
argument-hint: "[slug]"
---

# Archive

Resolve one active blueprint, archive it, and report the committed move.

@rules/blueprints.md and @rules/harness-compat.md apply.

Before archiving, store the resolved path in `file`, run
`blueprint validate "$file"`, and inspect the entire blueprint repository.
Stop if its index is nonempty or the current project has any dirty artifact:
the archive command stages that project subtree and commits the existing index.

## Arguments

- `[slug]` — exact or partial slug. When omitted, consider the most recent
  active blueprint.

## Workflow

### 1. Resolve One Target

- With a slug, inspect matching active blueprints and continue only when the
  target is unambiguous.
- Without a slug, resolve the most recent active blueprint with
  `blueprint find`. Show its path and obtain confirmation before moving it.
- If multiple artifacts match, show the candidates and ask the user to choose.
- Derive a unique selector from the resolved file's full stem, including its
  epoch prefix. If that full stem is duplicated across artifact types, stop:
  the archive command cannot safely distinguish them. Do not pass an ambiguous
  partial slug to the archive command.

### 2. Archive

```bash
blueprint archive <epoch-slug>
```

The command moves the file and commits the move; do not run a second
`blueprint commit`. If it exits non-zero, stop and show the error.

### 3. Report

Return `Archived: <archive-path>` using the path emitted by the command.
