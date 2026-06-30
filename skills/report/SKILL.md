---
name: report
description: >
  Create a durable post-implementation execution report. Invoke only as
  /skill:report or $report when a persistent report is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "[--branch <name>]"
---

# Report

Generate a post-implementation execution report and write it to
the blueprints repo.

## Arguments

- No args: auto-detect from current branch
- `--branch <name>`: override branch detection

## Steps

### 1. Derive Project

```bash
project=$(blueprint project)
```

### 2. Detect Branches

```bash
trunk=$(gt trunk 2>/dev/null || echo main)
branch=$(git branch --show-current)
```

Parse `$ARGUMENTS` for `--branch <name>` — if present, override
`$branch`.

### 3. Check for Commits

```bash
git log --oneline "$trunk".."$branch"
```

If empty (trunk == HEAD), report "No implementation commits found
on `$branch`" and **stop**.

### 4. Gather Git Data

Run in parallel:

```bash
# Commit list
git log --oneline "$trunk".."$branch"
```

```bash
# Diff stats
git diff --stat "$trunk".."$branch"
```

```bash
# Created files
git diff --diff-filter=A --name-only "$trunk".."$branch"
```

```bash
# Modified files
git diff --diff-filter=M --name-only "$trunk".."$branch"
```

```bash
# Deleted files
git diff --diff-filter=D --name-only "$trunk".."$branch"
```

### 5. Find Source Proposal (Optional)

```bash
source_file=$(blueprint find --type proposal,spec,plan)
```

If found, extract `$SOURCE_SLUG`: `SOURCE_SLUG=$(basename "$source_file" .md)`

Read it and extract acceptance criteria and approach headings for
proposal-vs-reality mapping.

### 6. Generate Slug

```bash
slug=$(blueprint slug "$branch")
```

### 7. Write Report

Create the report file:
```bash
file=$(blueprint create report "Report: <branch name>" --status complete --branch "$branch")
```
If a source artifact was found in step 5:
```bash
blueprint link "$file" "$SOURCE_SLUG"
```

Write the body content into `$file` (append after frontmatter).

**Body sections** (in order):

- **Summary** — 2-3 sentence editorial overview of what was
  implemented. Curate context, don't just echo the git log.

- **Commits** — table with columns: Hash, Message. One row per
  commit.

- **Files Changed** — three sublists: Created, Modified, Deleted.
  Each shows file paths. Omit empty sublists.

- **Stats** — lines added/removed, file count. From diff stats.

- **Proposal vs Reality** (only if a source was found) — each criterion or
  approach item mapped to completed, partial, or skipped. Brief
  note on deviations.

- **Watchouts** — prose on deviations, stuck or failed work, edge cases
  discovered during implementation, and follow-up suggestions. If nothing
  notable, write "None."

### 8. Commit-on-Write

Per @rules/blueprints.md:

```sh
blueprint commit report <slug>
```

If `blueprint commit` exits non-zero, STOP and alert the user
with the error output.

### 9. Report to User

Show:
- Report file path
- Commit count, files changed, lines added/removed
- Link to source proposal if one was used
