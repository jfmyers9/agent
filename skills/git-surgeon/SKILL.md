---
name: git-surgeon
description: >
  Perform non-interactive hunk-level Git staging, unstaging, and explicitly
  approved discards using ephemeral hunk IDs.
allowed-tools: Bash, Write
user-invocable: false
---

# Git Surgeon

Select text-diff hunks without opening an interactive Git prompt.

## Safety And Scope

- Preserve unrelated staged and unstaged changes.
- Treat IDs as ephemeral: re-list hunks immediately before every operation.
- Stage and unstage on request. Discard only when the user explicitly approves
  the destructive operation against freshly listed IDs.
- Do not apply hunk operations to binary files, submodules, untracked files, or
  file-level rename, copy, and mode-only changes. Report the required file-level
  operation instead.
- Never commit; this skill changes only the index or working tree requested.

## Build A Hunk Snapshot

Use deterministic, color-free diffs:

```sh
# Unstaged: index -> working tree
git diff --no-ext-diff --no-textconv --no-color --unified=3 --

# Staged: HEAD -> index
git diff --cached --no-ext-diff --no-textconv --no-color --unified=3 --
```

Parse paths from each `diff --git` record and preserve Git's exact file-header
lines. Each hunk starts at `@@ -a,b +c,d @@` and ends before the next hunk or
file record. The hunk content includes its `@@` header and every context and
change line exactly as emitted.

For each hunk, hash the byte sequence `<view> NUL <path> NUL <hunk>` with
`git hash-object --stdin` and use the first seven hexadecimal characters as its
ID. Do not normalize whitespace or line endings. If IDs collide within one
snapshot, suffix later occurrences with `-2`, `-3`, and so on.

List hunks in source order:

```text
ID       View       File                    Stats    Preview
a1b2c3d  unstaged   src/auth.ts             +5/-2    + const token = sign(...)
e4f5g6h  staged     src/auth.ts             +1/-1    - return null
```

Use the first added or removed source line as the preview; ignore file headers.
Show the complete stored hunk, including its header and context, when asked for
an ID.

## Build A Selective Patch

Resolve every requested ID against one fresh snapshot. For each affected file,
copy its exact patch headers and only the selected hunks. A normal text patch
must retain:

1. `diff --git ...`;
2. applicable metadata such as `index ...`;
3. `--- ...` and `+++ ...`; and
4. each selected `@@ ... @@` block with its exact content.

Build one patch for all requested IDs so the operation can be checked and
applied atomically. Do not interpolate patch text into a shell command; pass a
temporary patch file to `git apply`.

## Operations

### Stage

Source the patch from the unstaged snapshot, then run:

```sh
git apply --cached --check "$patch_file"
git apply --cached "$patch_file"
```

This updates the index without rewriting the working tree.

### Unstage

Source the patch from the staged snapshot and reverse-apply it to the index:

```sh
git apply --cached --reverse --check "$patch_file"
git apply --cached --reverse "$patch_file"
```

This preserves the working-tree content.

### Discard

After explicit approval, source the patch from the fresh unstaged snapshot and
reverse-apply it to the working tree:

```sh
git apply --reverse --check "$patch_file"
git apply --reverse "$patch_file"
```

Discard is destructive and may be unrecoverable. Re-list immediately before
applying; if an approved ID or its content changed, stop and request approval
for the new IDs.

## Verify

After any operation:

1. remove the temporary patch file;
2. inspect `git status --short`;
3. inspect fresh staged and unstaged diffs for every affected file; and
4. confirm that only the requested hunks moved or disappeared.

If `git apply --check` fails, do not retry with reduced context or force flags.
Re-list, rebuild from the current diff, and report persistent failures. If an ID
is missing, the diff changed; return the fresh list instead of guessing.
