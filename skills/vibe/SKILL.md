---
name: vibe
description: >
  Fully autonomous blueprint-backed development workflow from prompt
  to commit. Chains research → implement → review → fix → report →
  commit → submit. Triggers: /vibe, 'vibe this', 'autonomous workflow'.
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: "<prompt> [--continue] [--dry-run]"
---

# Vibe

Run the full development pipeline using blueprints as the only durable
state.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

## Arguments

- `<prompt>` — what to build, required unless `--continue`
- `--continue` — resume latest vibe tracker
- `--dry-run` — research only, stop before implementation

## Pipeline

```text
/skill:research --auto
/skill:implement --no-report
/skill:review
/skill:fix
/skill:implement --no-report
/skill:report
/skill:commit
/skill:submit
```

Do not use native task/team state. To invoke a stage, read that skill's
`SKILL.md` and follow its blueprint-backed workflow inline.

## Tracker Blueprint

Create a `plan/` blueprint as the pipeline tracker:

```bash
tracker=$(blueprint create plan "Vibe: <prompt>" --status draft)
```

Body:

```markdown
## Pipeline State

- prompt: <full prompt>
- stage: started
- spec:
- context:
- diagnosis:
- simplification:
- implementation:
- review:
- fix_plan:
- fix_implementation:
- report:
- commit:
- submit:
- skipped:

## Stage Log

### started
- <timestamp>: tracker created
```

After each stage, update `stage`, fill artifact paths/results, append a
Stage Log entry, and run `blueprint commit plan <tracker-slug>`. If a stage
is skipped, record `skipped: <stage> - <reason>` and a Stage Log entry; do
not leave silent gaps.

## Workflow

### 1. Parse / Resume

- If no prompt and no `--continue`, show:
  `/skill:vibe <what to build>`
- If `--continue`, find latest tracker with:
  `blueprint find --type plan --match vibe`
  Read `## Pipeline State` and resume after `stage`.
- Else create a new tracker.

### 2. Research

Read `skills/research/SKILL.md` and execute with:

```text
<prompt> --auto
```

Verify a spec blueprint exists via `blueprint find --type spec` and
store its path in tracker `spec`. If research created context, diagnosis,
or simplification artifacts, store those paths too. If `--dry-run`, stop
here and report `Next: /skill:implement`.

### 3. Implement

Read `skills/implement/SKILL.md` and execute against the spec path with
`--no-report`.

Verify implementation notes exist or expected git changes are present.
Store result in tracker `implementation`.

### 4. Review

Read `skills/review/SKILL.md` and execute on the current branch.

Verify a review blueprint exists and contains either `## Findings`,
`## Deferred Findings`, or a clear no-findings summary. Store path in
tracker `review`. Review failure is non-blocking only if implementation
produced changes; log the failure and continue to report/commit.

### 5. Fix Review Findings

Read the review blueprint. If it has no actionable findings under
`## Findings`, log `fix skipped: no actionable findings`. Deferred-only
items do not require a fix pass unless the user explicitly asks.

If actionable findings exist:

1. Read `skills/fix/SKILL.md` and create a fix plan from review
   findings.
2. Store fix plan path in tracker `fix_plan`.
3. Read `skills/implement/SKILL.md` and execute the fix plan with
   `--no-report`.
4. Store result in tracker `fix_implementation`.

Fix failure is non-blocking only if the original implementation is
useful; log the blocker clearly.

### 6. Report

Read `skills/report/SKILL.md` and execute it. Store report path in the
tracker. If report generation fails after useful implementation work, log
`report skipped: <reason>`; otherwise treat the failure as blocking.

### 7. Commit

If `git diff --stat` is empty, log `commit skipped`.

Otherwise read `skills/commit/SKILL.md` and execute it. Store
`git log -1 --oneline` in tracker `commit`.

### 8. Submit

Read `skills/submit/SKILL.md` and execute it. Store PR/submit result in
tracker `submit`. Submit failure is non-blocking after commit.

### 9. Complete

Before completion, verify every pipeline stage has either an artifact/result
or an explicit skip reason in `## Pipeline State` and `## Stage Log`.

When done:

```bash
blueprint status "$tracker" complete
blueprint commit plan <tracker-slug>
```

Report:

```text
Pipeline complete:
[1/7] Research: <spec>
[2/7] Implement: <result>
[3/7] Review: <review>
[4/7] Fix: <fix result>
[5/7] Report: <report>
[6/7] Commit: <commit>
[7/7] Submit: <submit result>
```

## Error Handling

If a blocking stage fails:

1. Do not advance tracker `stage`.
2. Append the error to `## Stage Log`.
3. Commit the tracker blueprint.
4. Report:
   ```text
   Pipeline halted at <stage>.
   Error: <details>
   Resume: /skill:vibe --continue
   Manual: /skill:<stage-skill>
   ```
