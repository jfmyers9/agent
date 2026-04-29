---
name: review
description: >
  Senior engineer code review, filing findings as tasks.
  Triggers: 'review code', 'code review', 'review my changes'.
allowed-tools: Bash, Read, Write, Task, SendMessage, TaskCreate, TaskUpdate, TaskGet, TaskList, TeamCreate, TeamDelete
argument-hint: "[file-pattern] [<branch|PR>] | <task-id> | --continue"
---

# Review

Orchestrate code review via tasks and Task delegation.

## Plan Directory

@rules/blueprints.md — subdirectory: `review/`, epoch-prefixed, e.g. `review/<epoch>-<slug>.md` where epoch = Unix seconds.

Use `blueprint create review "<topic>"` to create review files
with proper frontmatter.

## Arguments

- `<file-pattern>` — new review, optionally filtering files
- `<branch|PR>` — review a specific branch or PR number
- `<task-id>` — continue existing review task
- `--continue` — resume most recent in_progress review

## Workflow

### New Review

1. **Resolve target**
   Parse `$ARGUMENTS` for a branch/PR target:
   - Numeric (e.g. `123`) → resolve via
     `gh pr view "$ARG" --json headRefName -q .headRefName`,
     then `git checkout` the resolved branch
   - String that is not a task-id, `--continue`, or file-pattern
     → treat as branch name, `git checkout "$ARG"`
   - Empty → current branch (existing behavior)
   Store the resolved branch name in `$REVIEW_BRANCH`.

2. **Enter worktree** (only when an explicit branch/PR target was given)
   Skip this step when reviewing the current branch (no target).
   ```
   EnterWorktree(name="review-<slug>")
   git fetch origin $REVIEW_BRANCH
   git checkout $REVIEW_BRANCH || git checkout -b $REVIEW_BRANCH origin/$REVIEW_BRANCH
   ```
   Set `$IN_WORKTREE` = true if entered, false otherwise.

3. **Get branch context**
   - `git branch --show-current` → if main/master AND no
     explicit target was given in step 1, exit
   - `git diff main...HEAD --name-only` → changed files
   - Filter by `$ARGUMENTS` pattern if provided
   - Exclude: lock files, dist/, build/, coverage/, binaries
   - Fetch PR context:
     ```
     pr_context=$(gh pr view $PR_NUM --json title,body,labels \
       -q '{title,body,labels}' 2>/dev/null || echo "")
     ```
     Use `$PR_NUM` if `$ARGUMENTS` resolved to a PR number in
     step 1, otherwise omit it (uses current branch). Truncate
     body to first 500 words. Store as `$PR_CONTEXT`.

4. **Create review task**
   - TaskCreate:
     - subject: "Review: {branch}"
     - description: "All changed files reviewed for critical
       issues, design, and testing gaps. Findings stored in
       task metadata design field as phased structure."
     - metadata: {type: "task", priority: 2, branch: "$REVIEW_BRANCH"}
   - TaskUpdate(taskId, status: "in_progress")

5. **Perspective Mode**: Create a Claude team for coordinated
   multi-perspective review.

   a. Gather context:
      ```
      branch=$REVIEW_BRANCH
      log=$(git log main..HEAD --format="%h %s")
      files=$(git diff main...HEAD --name-only)
      diff=$(git diff main...HEAD)
      pr_context=$PR_CONTEXT
      ```
      Apply Large Diff Handling when gathering context.

      **CRITICAL: Pass raw diffs to agents, not summaries.**
      Agents need actual before/after lines to detect subtle
      changes. Summarizing hides exactly the details that matter.

   a2. **Detect primary language** from changed file extensions:
       - `.go` → go
       - `.ts`, `.tsx` → typescript
       - `.py` → python
       - `.rs` → rust
       Count files per language. If a recognized language has the
       most changed files → set `$LANG` to it. If no recognized
       language dominates or all files are config/docs → `$LANG`
       is empty (skip language reviewer).

   a3. **Detect plan file** for design coherence review:
       Compute `<branch-slug>` via `blueprint slug "$REVIEW_BRANCH"`.
       ```
       plan_file=$(blueprint find --type spec,plan --match <branch-slug>)
       if [ -z "$plan_file" ]; then
         plan_file=$(blueprint find --type archive --match <branch-slug>)
       fi
       if [ -z "$plan_file" ]; then
         plan_file=$(blueprint find --type review --match <branch-slug>)
       fi
       ```
       If `$plan_file` is found, extract the `## Spec` section
       content (everything from `## Spec` to the next `## ` heading
       or end of file) → store as `$SPEC_CONTENT`. If no `## Spec`
       section exists in the file, treat as no plan found.
       Set `$HAS_PLAN` = true if spec content was extracted,
       false otherwise.
       If `$HAS_PLAN` is true, extract `$SOURCE_SLUG` from the
       plan file: `SOURCE_SLUG=$(basename "$plan_file" .md)`

   b. Create team:
      `TeamCreate(team_name="review-<branch-slug>")`
      Read team config from the harness team directory if available
      (Claude default: `~/.claude/teams/review-<branch-slug>/config.json`)
      → extract your `name` field as `<lead-name>`

   c. Spawn all core workers in ONE message.
      CRITICAL: All Task calls MUST be in the SAME response.
      Sequential spawning causes slower execution.
      Workers inherit the lead's cwd (worktree if entered in
      step 2, otherwise project dir). Review is read-only so
      shared access is safe.
      Do NOT set isolation="worktree" on workers.
      ```
      Task(subagent_type="general-purpose",
           team_name="review-<branch-slug>",
           name="architect", model=opus,
           prompt=<Architect Prompt + Team Protocol>)
      Task(subagent_type="general-purpose",
           team_name="review-<branch-slug>",
           name="code-quality", model=opus,
           prompt=<Code Quality Prompt + Team Protocol>)
      Task(subagent_type="general-purpose",
           team_name="review-<branch-slug>",
           name="devils-advocate", model=opus,
           prompt=<Devil's Advocate Prompt + Team Protocol>)
      Task(subagent_type="general-purpose",
           team_name="review-<branch-slug>",
           name="operations", model=opus,
           prompt=<Operations Prompt + Team Protocol>)
      Task(subagent_type="general-purpose",
           team_name="review-<branch-slug>",
           name="test-quality", model=opus,
           prompt=<Test Quality Prompt + Team Protocol>)
      # If $LANG is set, include language reviewer in same message:
      Task(subagent_type="general-purpose",
           team_name="review-<branch-slug>",
           name="lang-<$LANG>", model=opus,
           prompt=<Language Reviewer Prompt ($LANG) + Team Protocol>)
      # If $HAS_PLAN is true, include coherence reviewer in same message:
      Task(subagent_type="general-purpose",
           team_name="review-<branch-slug>",
           name="coherence", model=opus,
           prompt=<Coherence Prompt ($SPEC_CONTENT) + Team Protocol>)
      ```
      Inject `<lead-name>` and gathered context into each
      prompt's placeholders. Worker count is 5 + 1 if `$LANG`
      is set + 1 if `$HAS_PLAN` is true (5, 6, or 7 workers).

   d. Wait for completion — track `completed_count` from
      worker SendMessage notifications. Expected count is
      5 + 1 if language + 1 if coherence (5, 6, or 7).
      When all expected workers done → aggregate. If a worker
      goes idle without completing → check TaskList, proceed
      when all non-stuck done. Tag partial results: "Note:
      <perspective> did not return results."
      If 2+ workers fail → aggregate available results, note
      which perspectives did not return findings, then clean up:
      `SendMessage(type="shutdown_request")` to each worker,
      `TeamDelete`, if `$IN_WORKTREE`:
      `ExitWorktree(action="remove")`.

   e. Aggregate findings (see Perspective Aggregation).

   f. Cleanup: `SendMessage(type="shutdown_request")` to each
      worker. After all acknowledge → `TeamDelete` →
      if `$IN_WORKTREE`: `ExitWorktree(action="remove")`.

6. **Store findings**
   a. Create review file:
      ```
      file=$(blueprint create review "Review: <branch-name>" --status draft)
      ```
      If `$HAS_PLAN` is true, link the source:
      ```
      blueprint link "$file" "$SOURCE_SLUG"
      ```
      Write findings body into `$file` (append after frontmatter).
   b. Store in task:
      `TaskUpdate(taskId, metadata: {
        design: "<findings>",
        plan_file: "review/$(basename $file)" })`
   c. Leave task in_progress

7. **Report results**

   ### Commit-on-Write

   Fires after every blueprint write or move per @rules/blueprints.md.
   ```sh
   blueprint commit review <slug>
   ```
   If `blueprint commit` exits non-zero, STOP and alert the user
   with the error output.

   (see Output Format)

### Continue Review

1. Resolve task ID:
   - If `$ARGUMENTS` matches a task ID → use it
   - If `--continue` → TaskList(), find first in_progress task
     with subject starting "Review:"
2. Load existing context:
   TaskGet(taskId) → extract metadata.design and metadata.branch
   - If `metadata.branch` exists → set `$REVIEW_BRANCH` to it
   - If not (legacy tasks) → fall back to current branch:
     `$REVIEW_BRANCH=$(git branch --show-current)`
3. Enter worktree (only if `$REVIEW_BRANCH` differs from current branch):
   ```
   EnterWorktree(name="review-<slug>")
   git fetch origin $REVIEW_BRANCH
   git checkout $REVIEW_BRANCH || git checkout -b $REVIEW_BRANCH origin/$REVIEW_BRANCH
   ```
   Set `$IN_WORKTREE` = true if entered, false otherwise.
4. Fetch PR context (same as step 3 of New Review):
   ```
   pr_context=$(gh pr view --json title,body,labels \
     -q '{title,body,labels}' 2>/dev/null || echo "")
   ```
   Truncate body to first 500 words. Store as `$PR_CONTEXT`.
5. Re-spawn in Perspective Mode: 5 core workers + language
   reviewer if `$LANG` detected + coherence reviewer if
   `$HAS_PLAN` (same as step 5 of New Review), each with
   "Previous team review findings:\n<design>\n\nContinue
   reviewing from the <perspective> perspective..."
6. Aggregate new findings with previous (re-run Perspective
   Aggregation)
7. Cleanup: `SendMessage(type="shutdown_request")` to each
   worker. After all acknowledge → `TeamDelete` →
   if `$IN_WORKTREE`: `ExitWorktree(action="remove")`.
8. Update design:
   `TaskUpdate(taskId, metadata: {design: "<updated>"})`
9. Commit-on-Write (same as New Review step 7)
10. Report results

## Review Scope

Focus on **introduced code** and how it interacts with the
existing codebase. The diff is the primary review surface.

- **Always review**: new/modified code, new patterns, new
  dependencies, changed interfaces, changed behavior,
  previously-ignored parameters/code paths now activated
- **Review if relevant**: existing code that the new code
  calls into or depends on (interaction quality), existing
  callers of changed functions (especially when a parameter
  goes from ignored/hardcoded to actually used)
- **Only flag existing code** if it has a truly critical flaw
  (security vulnerability, data loss, crash) — not style,
  not "while we're here" improvements

This principle applies to all review prompts below.

## Large Diff Handling

If total diff exceeds 3000 lines: for each file with >200 lines
of diff, truncate to first 50 + last 50 lines. Note truncations
in the prompt so subagents know to `Read` full files if needed.

Applies when gathering diffs for Perspective Mode.

## Prompt Templates

### Perspective Prompts

Perspective prompts live in `perspectives/` subdirectory adjacent
to this file. Each file has a `## Contract` header (required
output phases, shared concern tags, lane boundaries) and a
`## Prompt` section with the actual prompt in a code fence.

**Loading at spawn time:**
1. Discover `skills/review/perspectives/*.md` relative to this
   workflow repo or installed skills directory
2. `Read` each file, extract the code-fenced prompt from `## Prompt`
3. Spawn one agent per file (inject context placeholders + Team
   Worker Protocol appendix)

Core perspectives (always spawned):
- `perspectives/architect.md`
- `perspectives/code-quality.md`
- `perspectives/devils-advocate.md`
- `perspectives/operations.md`
- `perspectives/test-quality.md`

Conditional perspectives:
- `perspectives/coherence.md` — only when `$HAS_PLAN` is true
- Language reviewer — inline below (dynamically generated from
  `$LANG`)

#### Language Reviewer

Only spawned when `$LANG` is set. Use the matching block below.

```
You are a senior <$LANG> engineer with deep expertise in idiomatic
patterns and common pitfalls specific to the language ecosystem.

## PR Context
<pr_context — title, description, labels. If empty: "No PR
found — infer intent from commits below.">

## Language Focus

{{if $LANG == "go"}}
- **Error handling**: check `err != nil` consistently, no silently
  ignored errors, wrap with context via `fmt.Errorf("...: %w", err)`
- **Goroutine leaks**: ensure goroutines have cancellation paths,
  no unbounded spawns without context/done channels
- **Interface bloat**: interfaces should be small and consumer-defined,
  flag interfaces with 5+ methods or defined by the implementer
- **Context propagation**: `context.Context` passed as first arg,
  no `context.Background()` in library code, respect cancellation
{{else if $LANG == "typescript"}}
- **Type safety**: flag `any` usage, prefer unknown + narrowing,
  ensure generics are constrained, no unnecessary type assertions
- **Async/await**: no floating promises (missing await), proper
  error handling in async paths, no mixing callbacks and promises
- **Null/undefined handling**: use optional chaining and nullish
  coalescing, flag non-null assertions (`!`) without justification
- **Import cycles**: flag circular dependencies between modules
{{else if $LANG == "python"}}
- **Type hints**: consistency of annotations across function
  signatures, use of `Optional` / `Union` / modern `X | Y` syntax
- **Exception handling**: no bare `except:`, catch specific
  exceptions, preserve exception chains with `from`
- **Import structure**: stdlib → third-party → local ordering,
  no circular imports, no star imports
- **Context managers**: resources (files, connections, locks) must
  use `with` statements, flag manual open/close patterns
{{else if $LANG == "rust"}}
- **Ownership patterns**: unnecessary clones, borrowing where
  ownership isn't needed, overly complex lifetime annotations
- **Unsafe blocks**: each `unsafe` must have a `// SAFETY:` comment
  justifying soundness, minimize unsafe surface area
- **Error propagation**: prefer `?` over `.unwrap()` / `.expect()`
  in library code, use thiserror/anyhow appropriately
- **Lifetime clarity**: flag elided lifetimes that obscure intent,
  ensure lifetime names are descriptive in complex signatures
{{endif}}

## Scope
Focus on the INTRODUCED code (the diff). Only flag pre-existing
language issues if the new code directly depends on them.

## Branch
<branch-name>

## Commits
<git log main..HEAD --format="%h %s">

## Changed Files
<file list>

## Diffs
<git diff main...HEAD for each file>

Review each file strictly through a <$LANG> idiom lens using the
focus areas above.

Return COMPLETE findings as text (do NOT write files). Structure:

**Phase 1: Critical Issues**
<language-specific bugs or anti-patterns that will cause problems>

**Phase 2: Design Improvements**
<idiomatic improvements, better patterns>

**Phase 3: Testing Gaps**
<language-specific test patterns missing>

Only include phases that have findings. Skip empty phases.
For each finding: file, line(s), what's wrong, idiomatic fix.
Stay in your lane: ONLY flag language-specific idiom issues. Do not
flag architecture, security, operations, or shared concerns — those
are covered by other reviewers.
```

#### Team Worker Protocol

Append this to each perspective prompt:

```

## Team Protocol

1. Research and review using the prompt above.
   Return your COMPLETE findings as text.

2. When done, send your findings to the team lead:
   SendMessage(type="message", recipient="<lead-name>",
     content="<your full structured findings>",
     summary="<perspective> review complete")

3. Wait for shutdown request. When received, approve it.

## Rules
- Only review — do NOT modify any files
- If you notice something relevant to another perspective,
  mention it in your findings (the lead will cross-reference)
- Do NOT communicate directly with other reviewers
```

## Perspective Aggregation

After all expected workers report (or all-minus-1 if one failed),
merge:

### Step 1: Concatenate with source headers

```
--- ARCHITECT ---
<architect findings>

--- CODE QUALITY ---
<code-quality findings>

--- DEVIL'S ADVOCATE ---
<devil findings>

--- OPERATIONS ---
<operations findings>

--- TEST QUALITY ---
<test-quality findings>

# Only if coherence reviewer was spawned:
--- DESIGN COHERENCE ---
<coherence findings>

# Only if language reviewer was spawned:
--- LANGUAGE (<$LANG>) ---
<language reviewer findings>
```

### Step 1.5: Group shared-concern findings

Collect all `[shared:<category>]`-tagged findings across
perspectives. Group by category + file. For each group, synthesize
into one multi-angle finding that captures each perspective's take.
Remove the individual `[shared:*]` findings from the
per-perspective sections to avoid duplication in Step 3.

### Step 2: Scan for consensus

Compare findings across perspectives. Same file + same issue
area flagged by 2+ perspectives = consensus finding. Tag with
all agreeing sources: `[architect, code-quality]`.

### Step 2.5: Evaluate approach

Using PR context and all perspective findings, assess:

1. **Goal alignment**: Does the diff achieve what the PR
   description states? If no PR description, infer intent from
   commits and note "No PR description — inferred intent:
   <summary>".

2. **Premise check**: Does the fix actually fix the stated
   problem? Challenge the PR's own claims. If the PR says "fixes
   race condition X" but the race window is only narrowed (not
   closed), that's a finding — don't accept the PR description
   at face value.

3. **Approach fitness**: Given the stated goal, is this the
   right approach? Consider: simpler alternatives (Architect),
   fundamental risks (Devil's Advocate), operational concerns
   (Operations).

4. **Scope assessment**: Is the PR appropriately scoped? Too
   broad (multiple unrelated changes)? Too narrow (partial
   solution creating tech debt)?

Rate: Sound | Minor Concerns | Significant Concerns |
Alternative Recommended

If "Alternative Recommended", describe the alternative in 2-3
sentences with enough detail for the author to evaluate.

### Step 2.75: Correctness Verification (MANDATORY)

**Every finding must be verified against source before output.**

For EACH finding from Steps 1-2.5:
1. Read the actual code at `file:line` ± 20 lines of context
2. Check if the issue is handled elsewhere (nearby code,
   caller/callee, error handler)
3. Check if this is new in the PR or pre-existing
4. **Trace execution paths**: For findings involving async,
   concurrency, state machines, or multi-step flows — trace the
   full runtime path through guards, early returns, state
   transitions, and callbacks. Don't stop at the changed line;
   follow the control flow to its conclusion. Document the path
   in the finding.

Classify each finding:
- **Confirmed** — issue exists in changed code → keep
- **False positive** — issue doesn't exist, is handled
  elsewhere, or was misread → REMOVE
- **Pre-existing** — issue exists but predates this PR →
  downgrade severity or REMOVE (only keep if truly critical)
- **Uncertain** — can't determine from available context →
  tag with `[needs-review]`, keep

**Be aggressive about pruning.** 5 confirmed findings >
5 confirmed + 10 false positives. When in doubt between
false positive and uncertain, prefer `[needs-review]` over
keeping an unverified finding.

Log verification summary: "Verified N findings: K confirmed,
M false positives pruned, J pre-existing removed/downgraded,
L uncertain [needs-review]"

### Step 2.9: Group by root cause

Before building output, group all verified findings by root
cause. Multiple findings about the same underlying issue (e.g.,
"flush is fire-and-forget" surfacing as a design concern, a
comment accuracy issue, and a testing gap) become ONE finding
with multiple facets. This prevents the same issue from
appearing in 3 different sections.

For each root-cause group:
- Assign the highest severity from its constituent findings
- Combine the analysis from all perspectives into one narrative
- Include all suggested fixes (code, comment, test)
- Tag with all contributing perspectives

### Step 3: Build unified output

```
**Reviewer Summaries**
- **Architect**: <1-2 sentence overall assessment>
- **Code Quality**: <1-2 sentence overall assessment>
- **Devil's Advocate**: <1-2 sentence overall assessment>
- **Operations**: <1-2 sentence overall assessment>
- **Test Quality**: <1-2 sentence overall assessment>
# Only if coherence reviewer was spawned:
- **Design Coherence**: <1-2 sentence overall assessment>
# Only if language reviewer was spawned:
- **Language (<$LANG>)**: <1-2 sentence overall assessment>

**Approach Assessment**: <rating>
<1-3 sentences explaining the rating. Include premise check
result — does the fix actually fix what the PR claims?>

**Consensus** (2+ perspectives agree)
<numbered list, each finding is self-contained:>
1. **<severity>** <file:line> — <title> [perspectives]
   <full analysis — trace execution path if async/concurrent>
   **Suggested fix**: <concrete fix — code, comment, or test>

**Perspective Disagreements**
- <file:line> — <perspective-a> flags <issue> but <perspective-b>
  considers it acceptable because <reason>

# Only if coherence reviewer was spawned:
**Design Coherence**
- <spec violation or drift finding> [coherence]

**Phase 1: Critical Issues**
- <only findings NOT already in Consensus — self-contained>

**Phase 2: Design Improvements**
- <only findings NOT already in Consensus — self-contained>

**Phase 3: Testing Gaps**
- <only findings NOT already in Consensus — self-contained>
- For each gap: include a concrete test outline
  (setup → action → assertion)
```

Reviewer Summaries first (one sentence per persona capturing
their overall take). Then consensus items — these are the most
important findings, each self-contained with full analysis and
fix. Then disagreements — when one persona flags something as
critical but another's "Don't flag" list covers it, surface the
tension rather than silently dropping. Then Design Coherence (if
coherence reviewer was spawned). Then Phase sections for
remaining non-consensus findings only — no duplication with
Consensus. Skip empty sections. Most impactful first within
each section.

## Output Format

**Review Task**: #<id>

**Summary**: <files reviewed, commits covered>

**Approach Assessment**: <Sound | Minor Concerns |
  Significant Concerns | Alternative Recommended>
- <1-2 sentences on goal alignment and approach fitness>
- <alternative if warranted, or omit>

**Verification**: <N> findings checked, <M> false positives
pruned, <L> uncertain `[needs-review]`

**Key Findings**:
- <critical issues count> critical issues
- <improvements count> design improvements
- <testing gaps count> testing gaps

**Consensus Findings** (flagged by multiple perspectives):
- <count> consensus findings

**Plan**: `~/workspace/blueprints/<project>/review/<epoch>-<slug>.md` —
review/edit in `$EDITOR` before `/implement`.

**Next**: `/implement` to create tasks, or edit the plan first.

## Guidelines

- Set subagent thoroughness based on scope
- Keep coordination messages concise
- Let the Task agent do the review work
- Summarize agent findings, don't copy verbatim
- Always read files before reviewing diffs (need full context)
