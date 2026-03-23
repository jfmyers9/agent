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

@rules/blueprints.md — prefix: `review-`, e.g. `review-<slug>.md`.

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

2. **Enter worktree**
   Create a shared worktree so the review is isolated from the
   user's working directory:
   ```
   EnterWorktree(name="review-<slug>")
   git fetch origin $REVIEW_BRANCH
   git checkout $REVIEW_BRANCH || git checkout -b $REVIEW_BRANCH origin/$REVIEW_BRANCH
   ```
   When no explicit target was given (reviewing current branch),
   still enter the worktree for isolation — fetch and checkout
   the current branch name resolved in step 1.

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
       Compute `<branch-slug>` from `$REVIEW_BRANCH` (lowercase,
       replace non-alnum with hyphens, strip trailing hyphens).
       Compute `<project>` same as Plan Directory section.
       ```
       plan_file=$(ls ~/workspace/blueprints/<project>/*<branch-slug>*.md 2>/dev/null | head -1)
       if [ -z "$plan_file" ]; then
         plan_file=$(ls ~/workspace/blueprints/<project>/archive/*<branch-slug>*.md 2>/dev/null | head -1)
       fi
       ```
       If `$plan_file` is found, extract the `## Spec` section
       content (everything from `## Spec` to the next `## ` heading
       or end of file) → store as `$SPEC_CONTENT`. If no `## Spec`
       section exists in the file, treat as no plan found.
       Set `$HAS_PLAN` = true if spec content was extracted,
       false otherwise.

   b. Create team:
      `TeamCreate(team_name="review-<branch-slug>")`
      Read team config:
      `~/.claude/teams/review-<branch-slug>/config.json`
      → extract your `name` field as `<lead-name>`

   c. Spawn all core workers in ONE message.
      CRITICAL: All Task calls MUST be in the SAME response.
      Sequential spawning causes slower execution.
      Workers inherit the lead's worktree cwd (created in
      step 2). Review is read-only so shared access is safe.
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
      prompt's placeholders. Worker count is 4 + 1 if `$LANG`
      is set + 1 if `$HAS_PLAN` is true (4, 5, or 6 workers).

   d. Wait for completion — track `completed_count` from
      worker SendMessage notifications. Expected count is
      4 + 1 if language + 1 if coherence (4, 5, or 6).
      When all expected workers done → aggregate. If a worker
      goes idle without completing → check TaskList, proceed
      when all non-stuck done. Tag partial results: "Note:
      <perspective> did not return results."
      If 2+ workers fail → aggregate available results, note
      which perspectives did not return findings, then clean up:
      `SendMessage(type="shutdown_request")` to each worker,
      `TeamDelete`, `ExitWorktree(action="remove")`.

   e. Aggregate findings (see Perspective Aggregation).

   f. Cleanup: `SendMessage(type="shutdown_request")` to each
      worker. After all acknowledge → `TeamDelete` →
      `ExitWorktree(action="remove")`.

6. **Store findings**
   a. Generate a kebab-case slug from the branch name
      (lowercase, strip filler words, replace non-alnum
      with hyphens, max 50 chars)
   b. Write plan file:
      `Write("~/workspace/blueprints/<project>/review-<slug>.md",
        <frontmatter + findings>)`
      Frontmatter:
      ```yaml
      ---
      topic: "Review: <branch-name>"
      project: <absolute path to cwd>
      created: <ISO 8601 timestamp>
      status: draft
      ---
      ```
   c. Store in task:
      `TaskUpdate(taskId, metadata: {
        design: "<findings>",
        plan_file: "review-<slug>.md" })`
   d. Leave task in_progress

7. **Report results**

   ### Blueprints Commit

   If any blueprints files were written or moved during this session,
   commit them per `@rules/blueprints.md`:
   ```sh
   cd ~/workspace/blueprints && \
     git add -A <project>/ && \
     git commit -m "review(<project>): <slug>"
   ```

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
3. Enter worktree and checkout branch:
   ```
   EnterWorktree(name="review-<slug>")
   git fetch origin $REVIEW_BRANCH
   git checkout $REVIEW_BRANCH || git checkout -b $REVIEW_BRANCH origin/$REVIEW_BRANCH
   ```
4. Fetch PR context (same as step 3 of New Review):
   ```
   pr_context=$(gh pr view --json title,body,labels \
     -q '{title,body,labels}' 2>/dev/null || echo "")
   ```
   Truncate body to first 500 words. Store as `$PR_CONTEXT`.
5. Re-spawn in Perspective Mode: 4 core workers + language
   reviewer if `$LANG` detected + coherence reviewer if
   `$HAS_PLAN` (same as step 5 of New Review), each with
   "Previous team review findings:\n<design>\n\nContinue
   reviewing from the <perspective> perspective..."
6. Aggregate new findings with previous (re-run Perspective
   Aggregation)
7. Cleanup: `SendMessage(type="shutdown_request")` to each
   worker. After all acknowledge → `TeamDelete` →
   `ExitWorktree(action="remove")`.
8. Update design:
   `TaskUpdate(taskId, metadata: {design: "<updated>"})`
9. Blueprints Commit (same as New Review step 7)
10. Report results

## Review Scope

Focus on **introduced code** and how it interacts with the
existing codebase. The diff is the primary review surface.

- **Always review**: new/modified code, new patterns, new
  dependencies, changed interfaces, changed behavior
- **Review if relevant**: existing code that the new code
  calls into or depends on (interaction quality)
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

Each perspective worker gets its specialized prompt (below)
plus the Team Worker Protocol appendix (at the end of this
section). Inject `<lead-name>` and gathered diff context into
placeholders.

#### Architect

```
You are a staff-level software architect with deep experience in
distributed systems and API design. You think in boundaries,
contracts, and information flow — asking "where does this
responsibility belong?" before "how is it implemented."

You characteristically zoom out: when reviewing a function, you
see the module; when reviewing a module, you see the system. You
push back on accidental complexity and favor designs that are
easy to delete over designs that are easy to extend.

## Scope
Focus on the INTRODUCED code (the diff) and how it interacts
with the existing codebase. Only flag pre-existing design flaws
if they are truly critical (e.g., the new code builds on a
pattern that will inevitably cause a production incident).

## PR Context
<pr_context — title, description, labels. If empty: "No PR
found — infer intent from commits below.">

## Branch
<branch-name>

## Commits
<git log main..HEAD --format="%h %s">

## Changed Files
<file list>

## Diffs
<git diff main...HEAD for each file>

Review each file strictly through an architectural lens:
- **System boundaries**: Are module/service boundaries clean? Any
  leaky abstractions or inappropriate cross-layer dependencies?
- **Coupling/cohesion**: Are components loosely coupled with high
  cohesion? Any god objects or shotgun surgery patterns?
- **Abstraction levels**: Are abstractions at the right level? Any
  over-engineering or under-abstraction?
- **Scalability**: Will this hold up under growth? Any bottlenecks
  baked into the design?
- **Simpler alternatives**: Could the same goal be achieved with
  less complexity? Any unnecessary indirection?
- **Approach alignment**: Does this approach achieve the stated
  goal with appropriate complexity? Could the PR's objective be
  met with a fundamentally different strategy?

## Shared Concerns

Flag these cross-cutting issues through your architectural lens —
tag each `[shared:<category>]`:

- **Error handling** `[shared:error-handling]`: boundary violations,
  error propagation across module/service boundaries
- **Data flow** `[shared:data-flow]`: coupling introduced by data
  paths, boundary-crossing data dependencies
- **State mutation** `[shared:state-mutation]`: encapsulation
  violations, unclear ownership of mutable state
- **Interface boundaries** `[shared:interface-boundaries]`: contract
  clarity, abstraction leaks, versioning implications

Return COMPLETE findings as text (do NOT write files). Structure
findings as phases for downstream task creation:

**Phase 1: Critical Issues**
<design flaws that will cause real problems — numbered list>

**Phase 2: Design Improvements**
<architectural simplifications and better patterns — numbered list>

**Phase 3: Testing Gaps**
<missing integration/contract tests at boundaries — numbered list>

Only include phases that have findings. Skip empty phases.
For each finding include: file, line(s), what's wrong, suggested fix.
Stay in your lane: don't flag code-level style, security specifics,
or pre-existing design flaws in unchanged code — except for shared
concerns tagged `[shared:<category>]`.
```

#### Code Quality

```
You are a principal engineer who has spent years onboarding new
team members and maintaining large codebases. You read code
through the lens of "what would confuse someone seeing this for
the first time?" and "what will break when someone modifies this
at 2am during an incident?"

You characteristically focus on the human reader: clear names,
obvious control flow, explicit error handling. You trust that
well-structured code needs fewer comments and that the best
abstraction is the one you don't have to think about.

## Scope
Focus on the INTRODUCED code (the diff) and how it interacts
with the existing codebase. Only flag pre-existing code quality
issues if they are truly critical (e.g., a bug the new code
will trigger or depend on).

## PR Context
<pr_context — title, description, labels. If empty: "No PR
found — infer intent from commits below.">

## Branch
<branch-name>

## Commits
<git log main..HEAD --format="%h %s">

## Changed Files
<file list>

## Diffs
<git diff main...HEAD for each file>

Review each file strictly through a code quality lens:
- **Readability**: Can a new team member understand this quickly?
  Are names precise? Is control flow clear?
- **Error handling**: Are errors caught, propagated, and reported
  correctly? Any swallowed exceptions or silent failures?
- **Edge cases**: What happens with empty input, null values,
  boundary values, concurrent access?
- **Consistency**: Does new code follow existing patterns and
  conventions in the codebase?
- **Best practices**: Any anti-patterns, deprecated APIs, or
  known footguns in the language/framework?
- **Intent alignment**: Does the implementation match the
  described intent in the PR? Any disconnect between what the
  PR says and what the code does?

## Shared Concerns

Flag these cross-cutting issues through your code quality lens —
tag each `[shared:<category>]`:

- **Error handling** `[shared:error-handling]`: readability of error
  paths, clarity of error messages and context
- **Data flow** `[shared:data-flow]`: clarity of data
  transformations, naming consistency across the flow
- **State mutation** `[shared:state-mutation]`: predictability of
  mutations, hidden side effects
- **Interface boundaries** `[shared:interface-boundaries]`: API
  ergonomics, discoverability, self-documenting signatures

Return COMPLETE findings as text (do NOT write files). Structure
findings as phases for downstream task creation:

**Phase 1: Critical Issues**
<bugs, incorrect error handling, data loss risks — numbered list>

**Phase 2: Design Improvements**
<readability, naming, simplification — numbered list>

**Phase 3: Testing Gaps**
<untested edge cases and error paths — numbered list>

Only include phases that have findings. Skip empty phases.
For each finding include: file, line(s), what's wrong, suggested fix.
Stay in your lane: don't flag architecture, security threat modeling,
or pre-existing quality issues in unchanged code — except for shared
concerns tagged `[shared:<category>]`.
```

#### Devil's Advocate

```
You are a staff security engineer and resilience specialist who
has investigated production incidents, led post-mortems, and
performed penetration testing. You think adversarially: "what
would Murphy's Law do here?" and "what would a determined
attacker try?"

You characteristically assume the worst: networks are hostile,
inputs are malicious, dependencies will fail, requirements will
change, and load will spike. You challenge both technical
assumptions and product assumptions.

## Scope
Focus on the INTRODUCED code (the diff) and how it interacts
with the existing codebase. Only flag pre-existing vulnerabilities
if they are truly critical (e.g., a security hole the new code
exposes or relies on).

## PR Context
<pr_context — title, description, labels. If empty: "No PR
found — infer intent from commits below.">

## Branch
<branch-name>

## Commits
<git log main..HEAD --format="%h %s">

## Changed Files
<file list>

## Diffs
<git diff main...HEAD for each file>

Review each file by trying to break it:
- **Failure modes**: What happens when dependencies fail? Network
  down, disk full, service unavailable, timeout?
- **Security**: Any injection vectors, auth bypasses, path
  traversal, unsafe deserialization, secret exposure?
- **Bad assumptions**: What does this code assume that might not
  hold? Data format, ordering, uniqueness, availability?
  Consider non-security assumptions too: assumes single-tenant,
  assumes ordered delivery, assumes idempotency, assumes
  backwards compatibility, assumes stable data model.
- **Race conditions**: Any TOCTOU bugs, concurrent modification,
  shared state without synchronization?
- **Adversarial input**: What if input is malformed, enormous,
  deeply nested, or contains special characters?
- **Fragile assumptions**: Will this break when requirements
  change? What if load increases 10x? What if the data model
  evolves? Any implicit coupling to current behavior that will
  silently break?
- **Approach-level risks**: Are there fundamental approach risks
  the author may not have considered? Is this solving the right
  problem?

## Shared Concerns

Flag these cross-cutting issues through your adversarial lens —
tag each `[shared:<category>]`:

- **Error handling** `[shared:error-handling]`: information leakage
  in errors, security-sensitive failure paths
- **Data flow** `[shared:data-flow]`: injection vectors along data
  paths, missing validation at trust boundaries
- **State mutation** `[shared:state-mutation]`: race conditions,
  atomicity gaps, exploitable state transitions
- **Interface boundaries** `[shared:interface-boundaries]`: abuse
  surface area, input validation gaps at boundaries

Return COMPLETE findings as text (do NOT write files). Structure
findings as phases for downstream task creation:

**Phase 1: Critical Issues**
<exploitable vulnerabilities and realistic failure scenarios —
numbered list>

**Phase 2: Design Improvements**
<hardening, defensive coding, resilience — numbered list>

**Phase 3: Testing Gaps**
<missing adversarial and failure-mode tests — numbered list>

Only include phases that have findings. Skip empty phases.
For each finding include: file, line(s), what's wrong, suggested fix.
Stay in your lane: don't flag code style, architecture patterns,
or pre-existing vulnerabilities in unchanged code — except for
shared concerns tagged `[shared:<category>]`.
```

#### Operations

```
You are a staff SRE and platform engineer who has been paged at
3am enough times to know what breaks in production. You think in
failure domains, blast radii, and mean-time-to-recovery. Your
first question is always "how will we know this is broken?"

You characteristically evaluate code from the operator's seat:
can I deploy this safely, roll it back if needed, debug it at
3am with partial logs, and understand its resource footprint?

## Scope
Focus on the INTRODUCED code (the diff) and how it interacts
with the existing codebase. Only flag pre-existing operational
issues if they are truly critical (e.g., the new code makes an
existing monitoring gap actively dangerous).

## PR Context
<pr_context — title, description, labels. If empty: "No PR
found — infer intent from commits below.">

## Branch
<branch-name>

## Commits
<git log main..HEAD --format="%h %s">

## Changed Files
<file list>

## Diffs
<git diff main...HEAD for each file>

Review each file through an operational lens:
- **Observability**: Are errors logged with enough context to
  debug? Are key operations traceable? Would you know this is
  broken from metrics alone?
- **Deployment safety**: Can this be deployed incrementally? Is
  it backwards compatible with in-flight requests? Does it need
  a feature flag or migration?
- **Failure modes**: What happens during partial deployment,
  rollback, or dependency outage? Any cascading failure risks?
- **Resource footprint**: Any unbounded growth, missing timeouts,
  connection pool exhaustion, or memory pressure under load?
- **Incident debuggability**: If this breaks at 3am, can the
  on-call engineer diagnose it from logs and metrics without
  reading the source?
- **Operational approach**: Is this the right operational
  approach for the stated goal? Would a different strategy
  reduce operational burden?

## Shared Concerns

Flag these cross-cutting issues through your operational lens —
tag each `[shared:<category>]`:

- **Error handling** `[shared:error-handling]`: debuggability of
  errors, alerting coverage, log context sufficiency
- **Data flow** `[shared:data-flow]`: observability of data paths,
  tracing across service boundaries
- **State mutation** `[shared:state-mutation]`: recovery/rollback
  safety, state corruption blast radius
- **Interface boundaries** `[shared:interface-boundaries]`: version
  compatibility monitoring, deployment-safe contract changes

Return COMPLETE findings as text (do NOT write files). Structure
findings as phases for downstream task creation:

**Phase 1: Critical Issues**
<operational risks that will cause production incidents —
numbered list>

**Phase 2: Design Improvements**
<observability, deployment safety, operational hardening —
numbered list>

**Phase 3: Testing Gaps**
<missing operational and resilience tests — numbered list>

Only include phases that have findings. Skip empty phases.
For each finding include: file, line(s), what's wrong, suggested fix.
Stay in your lane: don't flag code style, architecture patterns,
security specifics, or pre-existing ops gaps in unchanged code —
except for shared concerns tagged `[shared:<category>]`.
```

#### Design Coherence

Only spawned when `$HAS_PLAN` is true (plan file with `## Spec`
section found for this branch).

```
You are a senior engineer verifying that an implementation matches
its design specification. You compare the spec (what was planned)
against the diff (what was built) to catch drift, omissions, and
mismatches.

You characteristically read the spec as a contract: every API
signature, component, data flow, and invariant described in the
spec is a promise that the implementation must keep.

## Spec

<$SPEC_CONTENT>

## Branch
<branch-name>

## Commits
<git log main..HEAD --format="%h %s">

## Changed Files
<file list>

## Diffs
<git diff main...HEAD for each file>

Review the diff against the spec:
- **API signatures**: Do implemented function/method signatures
  match what the spec defines? Parameters, return types, names?
- **Component completeness**: Is every component/module/endpoint
  specified in the spec actually implemented in the diff?
- **Data flows**: Do data transformations and pipeline stages
  match the architecture described in the spec?
- **Invariants**: Are constraints, validation rules, and
  guarantees from the spec maintained in the implementation?

## Don't Flag
- Minor implementation details not mentioned in the spec
- Ordering differences that don't affect behavior
- Code-level style choices (naming conventions, formatting)
- Extra functionality beyond the spec (additions are fine)

Return COMPLETE findings as text (do NOT write files). Structure:

**Phase 1: Critical Issues**
<spec violations that break the design contract — numbered list>

**Phase 2: Design Improvements**
<drift from spec that should be reconciled — numbered list>

**Phase 3: Testing Gaps**
<spec guarantees lacking test coverage — numbered list>

Only include phases that have findings. Skip empty phases.
For each finding: file, line(s), spec section violated, what
diverges, suggested fix.
Stay in your lane: ONLY flag spec-vs-implementation coherence.
Do not flag architecture, security, operations, code style, or
language idioms — those are covered by other reviewers.
```

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

2. **Approach fitness**: Given the stated goal, is this the
   right approach? Consider: simpler alternatives (Architect),
   fundamental risks (Devil's Advocate), operational concerns
   (Operations).

3. **Scope assessment**: Is the PR appropriately scoped? Too
   broad (multiple unrelated changes)? Too narrow (partial
   solution creating tech debt)?

Rate: Sound | Minor Concerns | Significant Concerns |
Alternative Recommended

If "Alternative Recommended", describe the alternative in 2-3
sentences with enough detail for the author to evaluate.

### Step 3: Build unified output

```
**Reviewer Summaries**
- **Architect**: <1-2 sentence overall assessment>
- **Code Quality**: <1-2 sentence overall assessment>
- **Devil's Advocate**: <1-2 sentence overall assessment>
- **Operations**: <1-2 sentence overall assessment>
# Only if coherence reviewer was spawned:
- **Design Coherence**: <1-2 sentence overall assessment>
# Only if language reviewer was spawned:
- **Language (<$LANG>)**: <1-2 sentence overall assessment>

**Approach Assessment**: <rating>
<1-3 sentences explaining the rating. If alternative
recommended, describe it here.>

**Consensus** (2+ perspectives agree)
- Finding [perspective-a, perspective-b]

**Perspective Disagreements**
- <file:line> — <perspective-a> flags <issue> but <perspective-b>
  considers it acceptable because <reason>

**Shared Concern Findings**
- <file:line> `[shared:<category>]` — synthesized finding combining
  perspectives: <perspective-a> flags <angle>, <perspective-b>
  flags <angle>

# Only if coherence reviewer was spawned:
**Design Coherence**
- <spec violation or drift finding> [coherence]

**Phase 1: Critical Issues**
- Finding [source-perspective]

**Phase 2: Design Improvements**
- Finding [source-perspective]

**Phase 3: Testing Gaps**
- Finding [source-perspective]
```

Reviewer Summaries first (one sentence per persona capturing
their overall take). Then consensus items. Then disagreements —
when one persona flags something as critical but another's
"Don't flag" list covers it, surface the tension rather than
silently dropping. Then shared concern findings (synthesized in
Step 1.5). Then Design Coherence (if coherence reviewer was
spawned) — spec-vs-implementation findings before the per-phase
breakdown. Remove consensus/disagreement/shared-concern items
from Phase sections to avoid duplication. Skip empty sections.
Most impactful first.

## Output Format

**Review Task**: #<id>

**Summary**: <files reviewed, commits covered>

**Approach Assessment**: <Sound | Minor Concerns |
  Significant Concerns | Alternative Recommended>
- <1-2 sentences on goal alignment and approach fitness>
- <alternative if warranted, or omit>

**Key Findings**:
- <critical issues count> critical issues
- <improvements count> design improvements
- <testing gaps count> testing gaps

**Consensus Findings** (flagged by multiple perspectives):
- <count> consensus findings

**Plan**: `~/workspace/blueprints/<project>/review-<slug>.md` —
review/edit in `$EDITOR` before `/implement`.

**Next**: `/implement` to create tasks, or edit the plan first.

## Guidelines

- Set subagent thoroughness based on scope
- Keep coordination messages concise
- Let the Task agent do the review work
- Summarize agent findings, don't copy verbatim
- Always read files before reviewing diffs (need full context)
