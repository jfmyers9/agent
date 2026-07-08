---
name: daily
description: >
  Generate a daily repository-attention summary of the user's open PRs, review
  requests, assigned issues, and recent trunk commits. Use only for a requested
  daily or repo-activity overview. Triggers: "daily summary", "repo activity".
allowed-tools: Bash
argument-hint: "[pathspec...]"
---

# Daily

Summarize what needs the user's attention in the current repository.

@rules/harness-compat.md applies.

## Arguments

- `[pathspec...]` — optional Git pathspecs used to filter PRs and trunk commits

## Workflow

1. **Resolve repository context**
   - Parse pathspecs as shell-quoted values, not executable text.
   - Verify the current Git repository and `origin` remote.
   - Resolve trunk from `refs/remotes/origin/HEAD`, then fall back to an existing
     `origin/main` or `origin/master`.
   - Fetch that trunk quietly. If fetch fails, continue with the cached ref but
     label trunk activity stale; if no trunk ref exists, mark it unavailable.

2. **Gather bounded data**
   - Run independent queries in parallel when the harness supports it:
     - open PRs authored by `@me`, including draft state, review decision,
       check rollup, URL, branch, and update time;
     - open PRs with `review-requested:@me`, including author and update time;
     - open issues assigned to `@me`, including labels and update time;
     - commits on the resolved trunk from the last 24 hours, restricted by the
       supplied pathspecs.
   - Use native limits (`gh ... --limit`, `git log --max-count`) and select only
     needed JSON fields. Never truncate JSON with `head` or `tail`.
   - Capture each query's status separately. Report unavailable GitHub data and
     its concise error; never convert command/authentication failure to `[]`.
   - Bound collection to 100 items per category. If a category reaches the cap,
     label its count `100+` rather than implying completeness.

3. **Apply optional path filtering**
   - Skip this step when no pathspec was supplied.
   - For each fetched PR, query its changed file names with a bounded `gh pr
     view` call and retain it when any file matches any supplied pathspec.
   - Run independent file queries in bounded parallel batches. If a PR's files
     cannot be fetched, mark its filter state unknown rather than excluding it.
   - Report how many fetched PRs were outside the filter. Do not path-filter
     assigned issues.

4. **Normalize status**
   - CI is `failing` when any check reports failure, error, cancellation,
     timeout, action-required, startup-failure, or stale; `pending` when any
     check is expected, requested, waiting, queued, or in progress; `passing`
     when completed checks have no failure state; `none` when no checks exist;
     and `unavailable` when the rollup could not be read.
   - Map review decisions to `approved`, `changes requested`, `pending`, or
     `none`. Describe review-request age as time since the PR was updated; do not
     claim it is the request timestamp.

5. **Print the summary**

```markdown
## Daily Summary — <YYYY-MM-DD>

### Your Open PRs (<count>)
- [#N](<url>) (draft|ready) <title> — CI: <state>, Review: <state>

### Review Requests (<count>)
- [#N](<url>) @<author> <title> — updated <relative time>

### Assigned Issues (<count>)
- [#N](<url>) <title> [<labels>]

### Recent Activity on <trunk> (last 24h)
- `<hash>` <subject>

### Needs Attention
- Review [#N](<url>) from @<author> — updated <relative time>
- Fix CI on [#N](<url>)
- Respond to requested changes on [#N](<url>)
```

Use `None` only after a successful empty query; use `Unavailable: <reason>` for
failed sources. Limit each displayed section to 10 items and state the omitted
count (or that the source query was capped).

Build **Needs Attention** in this order: review requests (least recently updated
first), authored PRs with failing CI, then authored PRs with requested changes.
Deduplicate PRs while preserving their highest-priority reason. Omit the section
when no gathered item matches.

Do not edit issues or PRs, post comments, change review state, or mutate branches.
