---
name: review
description: >
  Create a durable code review with a direct go/no-go decision and verified,
  merge-relevant findings. Invoke only as /skill:review or $review when a
  persistent initial review or bounded verification pass is wanted.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
argument-hint: >
  [--local|<branch>|<PR>] [--path <glob>] [--proposal <slug-or-path>]
  [--verify <review-slug-or-path>]
---

# Review

Decide whether introduced changes should proceed, be fixed, or be replaced,
then store the evidence in one review blueprint.

@rules/blueprints.md, @rules/harness-compat.md, and
@rules/artifact-readability.md apply.

Keep generated frontmatter intact and write the body below its closing `---`.

## Arguments

- `--local` — review staged, unstaged, and relevant untracked changes.
- `<branch>|<PR>` — review a branch diff or pull request.
- `--path <glob>` — restrict an initial review to matching changed files.
- `--proposal <slug-or-path>` — use one explicitly named decision and its
  acceptance criteria as evidence of intent.
- `--verify <review-slug-or-path>` — update one existing review by checking its
  unresolved findings against a persisted review basis.

`--verify` is mutually exclusive with every initial-review target and option.

## Decision Contract

Every review starts with a binary verdict and an explicit recommendation:

- `GO / proceed` — the premise and central approach are sound and no unresolved
  blocking findings remain. Every criterion from an explicit intent source
  passes. Deferred observations are allowed.
- `NO-GO / fix` — the central approach is viable, but bounded corrections are
  required before merge.
- `NO-GO / replace` — the premise is wrong or safe resolution requires
  discarding the central mechanism or ownership model.

Rate the approach separately: `sound` preserves the right central design,
`salvageable` permits bounded structural correction while preserving the
central mechanism and ownership model, and `misguided` requires replacing
them. Severity measures impact, not merge disposition. Every `F` finding
blocks; a `D` observation never blocks and never enters the default fix loop.

The verdict applies only to the recorded scope. A path-filtered review must say
`partial scope` and cannot authorize the changeset to merge. Do not recommend
proceeding with or replacing the whole changeset from a partial review; require
a full-scope review for that decision.

Use `replace` only when local corrections cannot make the approach acceptable.
Support it with decisive evidence and a feasible replacement shape, not taste
or a merely cleaner alternative. Begin its rationale: `Do not merge this changeset.`
Then say what to discard or rework. Do not soften that decision to “significant
concerns.”

## Workflow

### 1. Resolve The Mode And Target

For `--verify`, use an existing file path directly; otherwise resolve exactly
one review with `blueprint find --type review --match <target>`. Store its path
in `file`, then read its complete decision, basis, findings, deferred
observations, and resolutions. Verify that it belongs to the current
repository. Do not create a new review. Require the persisted `## Review Basis`
below; a legacy review without it requires a fresh review.

For an initial review:

- PR number: resolve its head and base without checking it out.
- Branch: review its merge-base diff against its PR base or Graphite parent,
  falling back to trunk. Check it out only when explicitly asked.
- `--local`: review staged and unstaged changes.
- No target: review the current branch, or local changes when on trunk.
- `--path`: apply the glob after resolving the change set. Treat a legacy
  positional path containing a directory separator or glob metacharacter as a
  path filter only when it cannot name a branch.

Resolve a proposal only when `--proposal` is present. Read an existing path
directly; otherwise require one unambiguous
`blueprint find --type proposal,spec,plan --match <target>` result. Record
whether the source is a blueprint or an ordinary repository document, its
content fingerprint, decision, non-goals, and every acceptance criterion. Do
not narrow that source to the implemented subset, guess from a branch name, or
silently adopt a stale design. For local reviews, inspect names before reading
relevant untracked source or tests and never read likely secret files
implicitly. Exclude generated files, build output, coverage, binaries, and
routine lockfile churn unless material.

### 2. Establish The Review Basis

For an initial review, collect changed files, diffs, commits, relevant PR
metadata, repository instructions, and the explicit proposal when supplied.
Record a finite basis before generating findings:

- objective and claimed problem, marked `inferred` when derived from commits or
  the diff;
- explicit intent source and criterion-by-criterion pass or unmet status;
- target and scope;
- base and reviewed head SHAs for a branch or PR;
- `HEAD`, changed paths, and deterministic tracked-diff fingerprints for local
  work, including a content hash for every reviewed hunk and untracked file;
- changed contracts, invariants, responsibilities, and external boundaries;
  and
- applicable lenses and the condition that activated each conditional lens.

If the objective cannot be established, do not invent it or create an
unfixable finding. Stop and request the missing objective.

Apply `perspectives/intent-approach.md` once to the whole changeset before
line-level review. Verify the premise, whether the mechanism achieves the
objective, responsibility placement, scope, and proportionality. A proposal is
evidence of intent, not unquestionable truth.

Treat a new public option, default, authorization gate, or similar product
boundary as part of the central approach. Verify that the explicit intent
source requires that boundary and that its default semantics preserve the
requested experience. If intent does not establish the choice, state the
required behavior without prescribing the new control; request clarification
when the distinction is central to the product.

### 3. Run One Initial Discovery Pass

If the approach gate establishes `NO-GO / replace`, stop exhaustive issue
mining. Verify the decisive evidence and any independent critical security,
data, or availability hazard, but do not inventory local repairs for code that
should be discarded.

Otherwise read the remaining checklists in `perspectives/` and apply:

- **Core:** correctness for behavior-affecting changes.
- **Conditional:** design and maintainability only for changed boundaries,
  responsibilities, ownership, abstractions, public surface, or nontrivial
  control flow; tests and verification only for changed behavior, changed
  tests, or a finding that needs regression proof; security and operations only
  for the specific activated subsections.

Proposal criteria are handled by the approach gate, not by an independent
compliance lens. Independent lenses may run in parallel only during this
initial pass. The workflow must not depend on subagents or harness-native task
state, and the primary reviewer owns synthesis.

When the approach gate finds a bounded failure to meet the objective,
acceptance criteria, or invariants, turn it into one cross-file `F` finding so
`NO-GO / fix` always identifies the work required. Keep `NO-GO / replace` in the
decision and replacement sections rather than decomposing it into local fixes.

Treat lens output as candidates. Keep an `F` finding only when all are true:

1. the target introduced or newly activated it;
2. a reachable behavior has concrete impact;
3. source, execution, or tool evidence establishes the problem; and
4. it must change before merge.

State the required observable outcome in each finding. Prescribe a particular
public API or product control only when the intent source or a demonstrated
safety constraint requires it; an existing internal switch is not evidence
that users should control it.

Trace callers, callees, state, and asynchronous paths as needed. Group
candidates by root cause before assigning IDs; include code and regression-test
facets in one finding rather than duplicating them across lenses. Record a
standalone test finding only when tests can miss a named regression or provide
false confidence.

Use `D` only for an evidenced, non-blocking risk worth preserving. Omit style,
optional cleanup, generic hardening, and speculative future work entirely.

### 4. Verify Without Reopening Scope

`--verify` is a closure pass, not another review. Do not rerun broad lenses or
search unchanged portions of the original diff for new medium or advisory
issues.

For a branch or PR, require the recorded base to remain unchanged, then compare
the immutable reviewed head with the current target. Include staged, unstaged,
and relevant untracked fix files when the target is the current worktree. A
changed PR base or Graphite parent requires a fresh review.

For local work, recompute the changed paths, per-hunk fingerprints, and
untracked content hashes.

On the first closure pass, derive the effective fix delta from the immutable
reviewed basis. On later passes, compare the last-verified path/hunk inventory
with the current one to identify newly changed areas while retaining the
original basis as the scope authority.

Every added, removed, or changed hunk/file in that effective delta must map to
an unresolved `F` ID and the change recorded in its resolution row; any unmapped
edit requires a fresh review. Previously verified, unchanged corrections remain
closed. If a newly changed area overlaps a verified finding, recheck that
finding and mark it failed only when the correction regressed. Inspect newly
mapped corrections, their affected dependency paths, and current tests. Check
closing resolutions (`fixed`, `already resolved`, or `not reproducible`)
against current behavior and update their verification to `verified` or
`failed`.

Preserve the original reviewed snapshot and update a separate last-verified
path/hunk fingerprint inventory after every closure pass. Use the latter only
to detect incremental edits, never to expand or replace the immutable scope.

Append a new stable `F` ID only when the fix introduced the blocker. Newly
available evidence of an original-scope miss requires a fresh review; do not
silently expand a closure pass. Never add a deferred observation during
verification.

If behavior or scope expanded beyond the recorded basis, stop and require a
fresh review. A replacement of the central approach also requires a fresh
review rather than verification against the discarded design.

A missing, `declined`, `pending`, or failed resolution remains unresolved. When
no unresolved `F` findings remain, re-rate any corrected structural approach.
Change the decision to `GO / proceed` only when the approach is `sound`.
Preserve every finding and stable ID; closure lives in the resolution table.

### 5. Classify And Write The Review

Assign stable sequential IDs (`F001`, `F002`, ... and `D001`, `D002`, ...), and
never renumber them.

Use `critical` for catastrophic security, data, or availability impact; `high`
for broken core behavior or a likely severe failure; and `medium` for a bounded
real defect that still must be fixed before merge. Low-impact observations are
deferred or omitted, never blocking findings.

```markdown
## Decision

- Verdict: GO | NO-GO
- Recommendation: proceed | fix | replace
- Approach: sound | salvageable | misguided
- Rationale: <direct decision rationale>
- Objective: <stated or explicitly inferred goal>
- Intent source: <path and fingerprint, or conversation/inferred>
- Acceptance: <every explicit criterion and pass or unmet status>
- Target: <branch, PR, or local diff and optional path scope>
- Decision scope: full changeset | partial paths
- Reviewed snapshot: <immutable base..head or local HEAD and fingerprint>
- Last verified snapshot: <head and path/hunk fingerprint inventory, or none>
- Lenses: <applied lenses and activation reasons>
- Blocking findings: <unresolved/total>
- Deferred: <count>

## Review Basis

- Mode: branch | PR | local
- Base: <base SHA and source, or none for local>
- Reviewed head: <commit SHA>
- Changed paths: <complete reviewed path list>
- Local fingerprints: <per-hunk and untracked-file hashes, or none>
- Contracts / invariants: <changed behavioral obligations>
- Boundaries / responsibilities: <affected ownership and external edges>
- Intent constraints: <decision, non-goals, defaults, and public controls>
- Exclusions: <anything deliberately outside the decision scope>

## Recommended Replacement

- Discard or rework: <what should not be preserved>
- Replacement shape: <specific alternative>
- Decisive evidence: <why local fixes are inadequate>

## Findings

### F001: <short title>

- Severity: critical | high | medium
- Location: `<path:line>` or `cross-file`
- Lenses: <names>
- Verification: source reading | execution verified | production/tool data
- Confidence: High | Medium
- Evidence: <what was inspected or run>

<introduced problem, concrete impact, and required change before merge>

## Deferred Observations

### D001: <short title>

- Location: `<path:line>` or `cross-file`
- Evidence: <verified non-blocking risk>

<why it does not affect the verdict>

## Resolutions

| Finding | Resolution | Verification | Change / Evidence |
| ------- | ---------- | ------------ | ----------------- |

## What I Verified

- <check and result>

## Considered And Dismissed

- <candidate and why it was pruned>
```

Omit empty replacement, deferred, and dismissed sections. Retain the resolution
table whenever findings exist. On verification, update the decision and table
in place rather than rewriting history or deleting resolved findings.

For findings that depend on a multi-boundary flow, include only the map, trace,
and evidence cross-reference needed by `@rules/artifact-readability.md`.

### 6. Store The Review

For an initial review:

```sh
file=$(blueprint create review "Review: <target>" --status complete --branch "$branch")
```

Omit `--branch` when none applies. Link an explicit source only when it is a
blueprint; cite an ordinary repository document in the review body instead:

```sh
source_slug=$(basename "$source_file" .md)
blueprint link "$file" "$source_slug"
```

For `--verify`, edit the resolved `file`; never create a replacement review.
After either mode, run `blueprint validate "$file"`, then
`blueprint commit review "$file"`. Stop on any error. Blueprint status remains
`complete`; the decision and resolutions in the body represent review state.

### 7. Report The Decision

Lead with the verdict and recommendation, then return the artifact path,
approach rating, unresolved finding IDs, and checks performed.

- `GO / proceed`: suggest `$commit` only for a full-scope decision.
- `NO-GO / fix`: suggest `$fix <review>`, followed by
  `$review --verify <review>`.
- `NO-GO / replace`: state plainly that the changeset should not merge and
  describe the replacement. Do not route it into a local fix loop.

## Rules

- Review introduced behavior first. Mention pre-existing code only when the
  change newly activates it or it creates critical context.
- Do not modify reviewed source or remote state. The review blueprint and its
  exact commit are the only intended writes.
- Perform one full discovery pass per recorded basis. Verification is monotonic
  closure over its findings, not an opportunity to restart discovery.
- Omit preferences and claims without concrete impact or evidence.
