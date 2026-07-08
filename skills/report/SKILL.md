---
name: report
description: >
  Create a durable post-implementation report from a committed branch diff and
  its verification evidence. Invoke only as /skill:report or $report when a
  persistent execution record is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "[--branch <name>] [--proposal <slug-or-path>]"
---

# Report

Summarize committed implementation work and store an evidence-backed report
blueprint.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.
Immediately before committing, run `blueprint validate "$file"` and inspect the
entire blueprint repository. Stop if its index is nonempty or the current
project has changes outside `$file`: `blueprint commit` stages the project
subtree and commits the existing index.

## Arguments

- No arguments — report the current branch.
- `--branch <name>` — report another local branch without checking it out.
- `--proposal <slug-or-path>` — compare the implementation with an explicit
  source proposal.

## Workflow

### 1. Resolve The Commit Range

Resolve the branch from `--branch` or `git branch --show-current`, and verify
that the ref exists. Resolve trunk from configured Graphite metadata, then the
remote default branch, then an existing `main` or `master` ref. Record the
exact refs used.

Use `<trunk>..<branch>` for commits and the merge-base range
`<trunk>...<branch>` for the implementation diff. If the commit range is empty,
return `No implementation commits found on <branch>` and stop without creating
a report.

Inspect `git status --short`. The report covers committed changes; list
relevant uncommitted changes under watchouts rather than implying they are in
the diff.

### 2. Resolve An Optional Source Proposal

- With `--proposal`, store and read the existing path as `source_file`, or
  resolve one unambiguous `source_file` with
  `blueprint find --type proposal --match <slug>`.
- Without `--proposal`, derive the branch slug with `blueprint slug "$branch"`
  and store the matching proposal as `source_file` only when its filename/topic
  and intent clearly match the branch. Do not run an unfiltered proposal search
  or attach a merely recent artifact.
- When a source is used, extract its decision, approach, acceptance criteria,
  and implementation notes for comparison.

No source proposal is a normal outcome.

### 3. Gather Implementation Evidence

Run bounded independent reads in parallel when possible:

```bash
git log --format='%h%x09%s' <trunk>..<branch>
git diff --stat <trunk>...<branch>
git diff --name-status <trunk>...<branch>
git diff --numstat <trunk>...<branch>
```

Inspect enough of the changed code and tests to explain what the commits
actually implement. Collect available verification from executed checks, CI,
and source proposal implementation notes. Never infer a passing check from
file names or commit messages; mark unavailable evidence as not verified.

### 4. Write The Complete Report

```bash
file=$(blueprint create report "Report: <branch>" --status complete --branch "$branch")
```

When the source proposal is a blueprint, link it:

```bash
source_slug=$(basename "$source_file" .md)
blueprint link "$file" "$source_slug"
```

Write these sections in order:

1. `## Summary` — editorial overview of the delivered behavior and scope, based
   on the diff rather than a restated commit log.
2. `## Snapshot` — branch, trunk/base ref, head SHA, commit range, and relevant
   working-tree state.
3. `## Human-Readable Map` — include a small diagram and trace only when the
   implementation changes non-trivial architecture or cross-boundary flow;
   otherwise state why it is omitted.
4. `## Commits` — `Hash` and `Message` table, one row per commit.
5. `## Files Changed` — `Created`, `Modified`, `Deleted`, and `Renamed` path
   lists; omit empty groups.
6. `## Stats` — file count and added/removed lines; identify binary changes
   separately instead of treating `-` as a number.
7. `## Verification` — command/check, result, and evidence label. State
   explicitly when verification was not run or could not be confirmed.
8. `## Proposal vs Reality` — only when a source proposal was used. Map each
   criterion and material approach item to `met`, `partial`, `not met`, or
   `not verified`, with evidence and deviations.
9. `## Watchouts` — uncommitted work, deviations, failed work, edge cases, and
   follow-ups. Write `None.` only after checking each category.

Keep raw logs out of the report and avoid claims stronger than the available
evidence.

### 5. Commit And Report

Run `blueprint commit report <slug>`. Stop and show the error if it fails.
Return the report path, commit count, file count, added/removed lines,
verification summary, and source proposal path when one was used.
