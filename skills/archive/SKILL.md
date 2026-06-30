---
name: archive
description: >
  Archive a durable artifact. Invoke only as /skill:archive or $archive.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Glob
argument-hint: "[slug]"
---

# Archive

Move a blueprint to `archive/` and commit.

## Arguments

- `[slug]` — filename or partial match (optional, defaults to
  most recent)

## Steps

1. Archive the blueprint:
   ```sh
   blueprint archive <slug>
   # or for most recent:
   blueprint archive
   ```
   If `blueprint archive` exits non-zero, STOP and alert the user
   with the error output.
2. Report: "Archived: `<filename>`"
