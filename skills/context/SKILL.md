---
name: context
description: >
  Create a durable, evidence-backed map of a bounded codebase area. Invoke only
  as /skill:context or $context when a persistent handoff report is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: >
  <scope> [--depth <quick|medium|high|max>] [--continue [slug]] [--link <slug>]
---

# Context

Map a bounded codebase area and store reusable evidence in a context report.

@rules/blueprints.md, @rules/context-budget.md,
@rules/harness-compat.md, and @rules/artifact-readability.md apply.

## Arguments

- `<scope>` — repository, subsystem, feature, path, symbol, or file set.
- `--depth <quick|medium|high|max>` — inspection breadth; default `medium`.
- `--continue [slug]` — refresh the latest or matching context report in place.
- `--link <slug>` — link an explicitly named source blueprint.

Depth ranges from entrypoints and primary verification (`quick`) through main
flows (`medium`), relevant failure paths (`high`), and reachable boundaries
inside the declared scope (`max`).

## Workflow

### 1. Resolve And Bound The Report

For `--continue <slug>`, resolve exactly one report with
`blueprint find --type report --kind context --match <slug>`. With bare
`--continue`, use the latest result from
`blueprint find --type report --kind context`. Read and update that file rather
than creating a replacement. Compare its snapshot commit with current `HEAD`;
mark stale claims and reverify anything the new handoff will rely on.

If no typed result exists, inspect `blueprint find --type report --all` and
accept only one legacy report whose topic and body clearly identify it as
context. Add `kind: context` to its frontmatter during the update. Never choose
an untyped generic report by recency alone.

For new work, require or derive a concrete scope. Record included paths,
symbols, behaviors, and exclusions. Ignore generated, vendored, build,
coverage, lockfile, and binary artifacts unless they are material.

Resolve `--link` with an exact or unambiguous
`blueprint find --type proposal,review,report,spec,plan --match <slug>`.
Preserve user changes and do not modify the product worktree.

### 2. Collect The Map

Find definitions and references before reading large files. Trace each material
behavior from its entrypoint through orchestration, state transformation, side
effects, output boundary, and representative test. Capture:

- branch, commit, dirty state, and UTC observation time;
- entrypoints, ownership boundaries, primary modules, state, and configuration;
- external CLI, API, UI, event, file, network, and database interfaces;
- tests, probes, verification commands, invariants, and sharp edges; and
- unresolved questions plus the cheapest discriminating check.

Verify material architecture claims against cited source. Use a small diagram
only when it makes a multi-boundary relationship easier to understand; add a
trace table when future work needs to map diagram nodes back to code.

### 3. Write One Concise Report

For new work:

```sh
file=$(blueprint create report "Context: <scope>" --status complete --kind context)
```

Use only relevant sections:

```markdown
## Summary

## Scope And Snapshot

## System / Flow Map

## Main Modules And Interfaces

## Important Code Paths

## Invariants And Risks

## Verification Commands

## Open Questions

## Handoff Notes
```

Cite paths and line numbers for claims future work may rely on. Keep raw logs
out of the report. Handoff notes should state what must be revalidated if the
snapshot commit differs from the consumer's `HEAD`.

When linking a source, derive its full filename stem and run
`blueprint link "$file" "$source_slug"` before the final validation.

### 4. Validate, Commit, And Report

For a continued draft report, set it to complete before committing. Then run:

```sh
blueprint validate "$file"
blueprint commit report "$file"
```

The CLI commits only the exact report and refuses a dirty blueprint index. Stop
on any error. Return the report path, snapshot commit, scope, and intended use.
