---
name: research
description: >
  Research topics, investigate codebases, and create
  implementation plans. Two-phase output: spec (what) then
  plan (how), each with user approval.
  Triggers: 'research', 'investigate', 'explore'.
allowed-tools: Bash, Read, Write, Task, SendMessage, TaskCreate, TaskUpdate, TaskGet, TaskList, TeamCreate, TeamDelete
argument-hint: "<topic or question> | <task-id> | --continue | --discard | --team | --depth <medium|high|max> | --auto"
---

# Research

Research -> spec -> approve -> plan -> approve. **Never research
on main thread** — subagents do all codebase exploration.

Two-phase output: **spec** (what) then **plan** (how). Each gets
user approval before proceeding.

## Arguments

- `<topic>` — new research on this topic
- `<task-id>` — continue existing research task
- `--continue` — resume most recent research (checks task list
  first, then falls back to most recent plan file, then archive)
- `--discard [slug]` — delete the most recent (or specified) plan
  file without preparing it
- `--team` — force team mode for parallel multi-topic research
- `--depth <level>` — control research thoroughness (default: medium)
  - `medium` — key files, file paths without snippets, 3-5 phases
  - `high` — all relevant files, 2-level call chains, line refs
    with brief code context, dependency chains, 5-7 phases
  - `max` — exhaustive: all touched modules, full call chains,
    full dependency graph, annotated snippets, cross-reference
    matrix, 7+ phases with sub-steps and verification criteria
- `--auto` — skip approval gates (for inner-skill calls like
  /vibe). Speed over polish.

## Plan Directory

@rules/blueprints.md — e.g. `spec/<epoch>-<slug>.md`. Archived plans
(consumed by `/implement`) live in `archive/` and can be restored
via `--continue`.

Use `blueprint create spec "<topic>" --depth <level>` to create plan
files with proper frontmatter. The skill writes body content into
the returned file path.

## Slug Generation

Use `$(blueprint slug "<topic>")` to generate slugs.

## Plan File Format

```markdown
---
topic: <original topic text>
project: <absolute path to current working directory>
created: <ISO 8601 timestamp>
status: draft | spec_review | spec_approved | plan_review | approved
depth: <medium|high|max>
---

## Spec

<spec content — timeless target-state description>

## Plan

<phased implementation plan>
```

## Workflow

### New Research

1. **Create task:**
   ```
   TaskCreate(
     subject: "Research: <topic>",
     description: "## Acceptance Criteria\n- Spec and plan written to ~/workspace/blueprints/<project>/spec/<epoch>-<slug>.md\n- Spec: timeless target-state (Problem, Recommendation, Architecture, Risks)\n- Plan: phased Next Steps with file paths and done signals",
     activeForm: "Researching <topic>",
     metadata: { type: "task", priority: 2 }
   )
   ```
   `TaskUpdate(taskId, status: "in_progress")`

2. **Parse flags** and classify topics from $ARGUMENTS:
   - Extract `--depth <level>` if present (default: medium).
   - Extract `--team` and `--auto` flags if present.
   - Strip flags; remainder is topic text.
   - Classify topic text to determine mode:
     - Numbered list items / bullet points -> extract each
     - Comma-separated phrases with "and" -> split on commas
     - Multiple sentences ending in `?` -> each is a topic

   If 2+ topics detected OR `--team` flag -> **Team Mode** (step 3b)
   Otherwise -> **Solo Mode** (step 3a)

3. **Spawn research agent(s).**

   **a) Solo Mode** — spawn Task (subagent_type=Explore,
   model=opus) using the solo prompt template below.

   **b) Team Mode** — see Team Mode section below.

4. **Validate research:** spot-check architectural claims before
   proceeding — wrong architecture = wrong plan.
   - File/behavioral claims: check every odd-numbered claim
     (1st, 3rd, 5th...), minimum 3.
   - Each check: Grep or Read a few lines — do NOT read entire
     files.
   - Failed check -> dispatch follow-up subagent to correct.

### Spec Phase (what we're building)

5. **Synthesize spec** from validated research. The spec is a
   **timeless target-state document** — it describes the system
   as if already built. After implementation, it should still
   read as a valid specification.

   - **Problem**: what's broken or missing (the only section that
     may describe current state).
   - **Recommendation**: target behavior in present tense,
     strategy-level. "Webhook delivery uses exponential backoff
     via BullMQ" — not "Add exponential backoff." No transition
     verbs (add, replace, migrate, move, change).
   - **Architecture Context**: the code landscape
     post-implementation. Describe by module role and pattern,
     not file path. Paths may appear parenthetically.
   - **Risks**: edge cases, failure modes, constraints

   The spec excludes implementation details: phases, task
   breakdowns, files to create/modify. Those belong to the plan.

6. **Simplify + challenge spec** — two parallel quality gates
   before storing.

   **Simplification** (conditional): fires when spec has >5 bullet
   points in Recommendation OR >3 subsections in Architecture
   Context. Spawn Task (subagent_type=Explore, model=opus):
   ```
   Review this spec for over-specification. Flag:
   - Recommendations that solve unstated problems
   - Architecture components that can be merged
   - Speculative flexibility not required by the problem

   Spec:
   <spec content>

   Return specific simplifications, or "No simplifications needed".
   ```

   **Devil's advocate** (always): fires on every spec. Spawn Task
   (subagent_type=Explore, model=opus):
   ```
   Challenge this spec's assumptions:
   - Is the problem real and worth solving?
   - Is the scope right, or is it solving too much / too little?
   - What's the simplest version that addresses the core problem?

   Spec:
   <spec content>

   Return 1-3 challenges, or "Spec is sound".
   ```

   If both fire, spawn BOTH in a single message for parallelism.
   Apply accepted simplifications to the spec. Carry challenges
   forward to step 8 (spec presentation).

7. **Store spec:**
   - Create plan file:
     ```
     file=$(blueprint create spec "<topic>" --status spec_review --depth <level>)
     ```
     Write spec content body into `$file` (append after frontmatter).
   - `TaskUpdate(taskId, metadata: { spec: "<spec content>",
     plan_file: "spec/$(basename $file)", depth: "<level>",
     status_detail: "spec_review" })`

8. **Present spec** — `Spec: t<id> — <topic>`, then Problem,
   Recommendation, Architecture Context, Risks, Challenges.
   Include the devil's advocate challenges from step 6 in a
   **Challenges** section after Risks.
   If `--auto` -> skip to step 10. Otherwise -> stop for review.

9. **Spec refinement** — if user gives feedback:
   - **Minor (no new research needed):** revise from stored
     research + feedback. Update metadata.spec and plan file.
   - **Major (unexplored code or new approach):** dispatch
     follow-up subagent with current spec as context. Merge
     findings. Update metadata.spec and plan file.
   - Re-present spec. Repeat until approved.

10. **Approve spec:**
   `TaskUpdate(taskId, metadata: { status_detail: "spec_approved" })`
   `blueprint status "$file" spec_approved`

### Plan Phase (how we're building it)

11. **Generate plan** from approved spec + research findings:
    - Per phase: title, files (Read/Modify/Create), approach, steps
    - Dependencies between phases
    - Every step must include file paths — /implement depends on them

12. **Store plan:**
    - Update plan file with plan content, `status: plan_review`
    - `TaskUpdate(taskId, metadata: { design: "<plan content>",
      status_detail: "plan_review" })`

    metadata.design must be self-contained — full phased breakdown
    with file paths, approaches. /implement reads this without
    conversation context.

13. **Present plan** — `Plan: t<id> — <topic>`, then phased
    approach, dependencies, `Next: /implement`.
    If `--auto` -> skip to step 15. Otherwise -> stop for review.

14. **Plan refinement** — if user gives feedback:
    - **Minor:** revise from stored plan + feedback. Update
      metadata.design and plan file.
    - **Major (new codebase data):** dispatch follow-up subagent
      with metadata.design as prior findings. Merge. Update.
    - **Spec affected?** If feedback changes WHAT (scope, goals,
      risks) — not just HOW — update metadata.spec too.
    - Re-present plan. Repeat until approved.

15. **Approve and finalize:**
    - `blueprint status "$file" approved`
    - `TaskUpdate(taskId, metadata: { status_detail: "approved" })`

    ### Commit-on-Write

    Fires after every blueprint write or move per @rules/blueprints.md.
    ```sh
    blueprint commit spec <slug>
    ```
    If `blueprint commit` exits non-zero, STOP and alert the user
    with the error output.

    - Report: plan file path, `Next: /implement`

### Continue Research

1. Resolve source:
   - If `$ARGUMENTS` matches a task ID -> `TaskGet(taskId)`
   - If `--continue` -> `TaskList()`, find first in_progress
     "Research:" task. If none found, find most recent plan file
     via `blueprint find --type spec`
   - If no active plan found, check archive:
     `blueprint find --type archive`
     If found, copy it back to active.
     Report: "Restored archived plan: `<filename>`"

2. Load existing context:
   - From task: read `metadata.spec`, `metadata.design`,
     `metadata.depth`, `metadata.status_detail`
   - From plan file: `Read` the file, extract frontmatter fields
   - If user provides `--depth` flag, use it (override).

3. Route by status_detail:
   - `approved` -> already approved. Report and suggest `/implement`.
   - `spec_review` / `spec_approved` -> re-present spec, resume
     from step 8 or 11 respectively.
   - `plan_review` -> re-present plan, resume from step 13.
   - No status / `draft` -> dispatch subagent with previous
     findings prepended, resume from step 4.

### Discard Plan

1. If slug provided after `--discard`:
   - Find file: `blueprint find --type spec --match <slug>`
   - Delete the returned file.
2. If no slug -> find most recent:
   `blueprint find --type spec`
   Then delete the returned file.
3. Report: "Discarded plan: `<filename>`"


### Commit-on-Write

Fires after every blueprint write or move per @rules/blueprints.md.
```sh
blueprint commit spec <slug>
```
If `blueprint commit` exits non-zero, STOP and alert the user
with the error output.

## Team Mode

When 2+ topics detected or `--team` flag:

1. Create team: `TeamCreate(team_name="research-<slug>")`
   Read team config from the harness team directory (Claude default:
   `~/.claude/teams/research-<slug>/config.json`) if available,
   then extract your `name` field as `<lead-name>`
2. Create per-topic tasks under the main research task.
   Cap at 5 topics; group excess together.
   ```
   TaskCreate(
     subject: "Research: <topic-N>",
     description: "<topic text>",
     activeForm: "Researching <topic-N>",
     metadata: { type: "task", parent_id: "<main-task-id>" }
   )
   ```
3. Spawn ALL workers in a SINGLE message using the team
   worker prompt template below. One Task call per topic:
   ```
   Task(
     subagent_type="general-purpose",
     team_name="research-<slug>",
     name="researcher-<N>",
     model=opus,
     prompt=<team worker prompt>
   )
   ```
   CRITICAL: All Task calls in ONE message for true parallelism.
4. Wait for completion — track `completed_count` from worker
   SendMessage notifications. When all done -> proceed. If a
   worker goes idle without completing -> check TaskList, mark
   stuck tasks, proceed when all non-stuck workers done.
5. Aggregate findings (see Team Mode Aggregation).
6. Cleanup: `SendMessage(type="shutdown_request")` to each
   worker. After all acknowledge -> `TeamDelete`.
7. Proceed to step 4 (validate research) in main workflow.

### Team Mode Aggregation

After all workers complete, collect findings from each worker's
task metadata:

For each topic task: `TaskGet(taskId)` -> extract `metadata.notes`

Then combine:
1. Prefix each topic's findings with **Topic N: <name>**
2. Detect cross-topic connections (shared files, dependencies,
   conflicts)
3. Renumber phases globally across all topics (Phase 1-N
   sequential) so /implement can parse them
4. If cross-topic connections found, add a **Cross-Topic
   Connections** section at the top

## Prompt Templates

### Solo Prompt

Spawn Task (subagent_type=Explore, model=opus) with:

```
Research <topic> thoroughly. Return your COMPLETE findings as
text output (do NOT write files).

<inject the depth block for the selected --depth level>

Structure:

1. **Current State**: What exists now (files, patterns, architecture)
2. **Recommendation**: Suggested approach with rationale
3. **Next Steps**: 3-7 phases, each independently testable.

Each step must include:
- **Action**: verb + target (what to do)
- **Location**: file path with line ref when modifying existing code
- **Context**: why, when non-obvious
- **Done signal**: how to verify completion

Example step: "Add rate-limit middleware to `src/api/router.ts:45`
— wrap existing handler with `rateLimit()`. Verify: returns 429
after 100 req/min."

**Phase 1: <Description>**
1. <step with action, location, context, done signal>
2. ...

**Phase 2: <Description>**
3. ...
```

### Team Worker Prompt

Team workers use `subagent_type=general-purpose` (not Explore)
so they can use SendMessage for coordination.

```
You are a research worker on a team. Research your assigned
topic and report back.

## Your Topic
<topic text>

## Overall Context
<original user request>

## Your Task ID
<task-id>

## Protocol

1. Claim your task:
   TaskUpdate(taskId="<task-id>", status="in_progress",
     owner="researcher-<N>")

2. Research thoroughly. Use Read, Grep, Glob, Bash for
   investigation. Return findings as text (do NOT write files).
   <inject the depth block for the selected --depth level>

3. Structure findings:
   **Current State**: What exists now
   **Recommendation**: Suggested approach
   **Next Steps**: 3-7 phases, each independently testable.
   Each step: action (verb + target), location (file path
   with line ref), context (why, if non-obvious), done signal
   (how to verify).

4. When done, complete the task with your findings:
   TaskUpdate(taskId="<task-id>", status="completed",
     metadata={ notes: "<your full findings>" })

5. Send completion message to team lead:
   SendMessage(type="message", recipient="<lead-name>",
     content="Completed: <brief summary of findings>",
     summary="Completed topic <N>")

6. Wait for shutdown request. When received, approve it.

## Rules
- Only research — do NOT modify any files
- If blocked, report via SendMessage instead of guessing
- Do NOT work on other topics after completing yours
```

## Depth Levels

Both solo and team worker prompts contain a placeholder:
`<inject the depth block for the selected --depth level>`.
Replace it with the block matching the parsed `--depth` value:

**medium** (default):
```
Read key files to understand architecture. Report file paths
without code snippets. Produce 3-5 phases in Next Steps.
```

**high**:
```
Read all relevant files and trace call chains 2 levels deep.
Include line references and brief code context for non-obvious
patterns. Map dependency chains between affected modules.
Produce 5-7 phases in Next Steps, each independently testable.
```

**max**:
```
Exhaustive research. Read all touched modules, trace every call
chain to its origin, map the full dependency graph. Provide
annotated code snippets for all findings. Build a cross-reference
matrix of callers, shared state, and coupling between components.
Produce 7+ phases in Next Steps with sub-steps and explicit
verification criteria per phase.
```

## Output Format

### Spec Output (step 8)

**Spec: t<id> — <topic>**

**Problem**: <what's broken or missing>

**Recommendation**: <target behavior, present tense>

**Architecture Context**: <post-implementation landscape>

**Risks**: <edge cases, failure modes>

**Challenges**: <devil's advocate challenges from step 6, if any>

Next: approve to proceed to plan, or give feedback.

### Plan Output (step 13)

**Plan: t<id> — <topic>**

<Phased approach — per phase: title, files, approach>

**Plan**: `~/workspace/blueprints/<project>/spec/<epoch>-<slug>.md` — review/edit
in `$EDITOR` before `/implement`.

**Next**: `/implement` to execute, edit the plan file first,
or `/research --discard` if not needed.
