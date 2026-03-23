---
name: implement
description: >
  Execute implementation plans from tasks. Detects epics and spawns
  teams for parallel work.
  Triggers: 'implement', 'build this', 'execute plan', 'start work'.
allowed-tools: Bash, Read, Glob, Write, Task, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamCreate, TeamDelete
argument-hint: "[task-id] [--solo] [--team]"
---

# Implement

Execute work from tasks, spawning teams for parallel execution.

CRITICAL: This skill is a pure orchestrator. Do NOT implement code
directly — always delegate to Task agents (`subagent_type=general-purpose`).
Bash is for read-only orchestration only (git status, team config reads).

## Arguments

- `task-id` — epic or task ID (optional)
- `--solo` — force single-agent mode even for epics
- `--team` — force Swarm Mode (auto-creates ad-hoc epic if needed)

## Step 1: Find Work

- If ID in `$ARGUMENTS` → use it
- Else: `TaskList()` → find first in_progress task where
  `metadata.type == "epic"` (Swarm Mode)
- Else: `TaskList()` → find first pending task where
  `metadata.type == "epic"` (Swarm Mode)
- Else: `TaskList()` → find first in_progress task (Solo Mode)
- Else: `TaskList()` → find first pending task with empty
  blockedBy (Solo Mode)
- Nothing found → proceed to **Step 1b: Auto-Prepare**

## Step 1b: Auto-Prepare

If Step 1 found no tasks, check for plan files before exiting.

1. Determine project per @rules/blueprints.md.
2. Scan: `ls -t ~/workspace/blueprints/<project>/*.md 2>/dev/null | head -1`
3. If no plan file → exit, suggest `/research`
4. Read the plan file. Skip YAML frontmatter (between `---` lines).
5. Parse phases: find `**Phase N: Description**` or `### Phase N:`
   markers. Extract numbered list items under each phase.
6. Detect dependencies:
   - Default: sequential (each phase blocks the next)
   - Parallel if phase text contains: "parallel with Phase N",
     "independent of", "no dependency"
7. Create epic:
   ```
   TaskCreate(
     subject: "<plan title from first heading>",
     description: "<one-paragraph summary>\n\n## Design Rationale\n
       <plan's Recommendation section — approach chosen and why>\n\n
       ## Success Criteria\n<3-5 outcomes>",
     activeForm: "Implementing <title>",
     metadata: { type: "epic", priority: 1 }
   )
   ```
8. Copy full plan text into epic:
   `TaskUpdate(epicId, metadata: { design: "<full plan text>" })`
9. For each phase, build a rich description by extracting from the plan:
   - **Context**: file paths from plan's "Current State" section relevant
     to this phase, plus a one-line rationale from plan's "Recommendation"
   - **Acceptance Criteria**: the checklist items under the phase
   - **Verification**: test expectations or edge cases from plan (if any)
   ```
   TaskCreate(
     subject: "Phase N: <description>",
     description: "## Context\n<relevant file paths from Current State>\n
       <one-line rationale from Recommendation>\n\n
       ## Acceptance Criteria\n<checklist from phase>\n\n
       ## Verification\n<test expectations or edge cases, if any>",
     activeForm: "Phase N: <description>",
     metadata: { type: "task", parent_id: "<epic-id>", priority: 2 }
   )
   ```
10. Set blockedBy for sequential phases:
    `TaskUpdate(phaseN+1, addBlockedBy: ["<phaseN-id>"])`
11. Archive plan file:
    ```
    mkdir -p ~/workspace/blueprints/<project>/archive/
    mv <plan-file> ~/workspace/blueprints/<project>/archive/
    ```
    Then commit the move:
    ```sh
    cd ~/workspace/blueprints && \
      git add -A <project>/ && \
      git commit -m "implement(<project>): <slug>"
    ```
12. `TaskUpdate(epicId, status: "in_progress")`
13. Proceed to Step 2 with the new epic.

## Step 2: Classify

`TaskGet(taskId)` to inspect.

**Epic?** → `metadata.type == "epic"` → **Swarm Mode** (unless `--solo`)
**`--team` flag + not an epic?** → **Ad-hoc Swarm Mode** (see below)
**Task with parent?** → has `metadata.parent_id` → read parent
  for context, **Solo Mode**
**Standalone task?** → **Solo Mode**
  - If `--team` was requested but only 1 standalone task exists,
    report: "Solo Mode: only 1 task found. Run `/research` first
    to create a plan with multiple phases."

### Ad-hoc Swarm Mode

When `--team` is passed but the target is not an epic:

1. Gather pending tasks: `TaskList()` → filter tasks with
   `status == "pending"` and empty `blockedBy`
2. If <2 eligible tasks → report and fall to Solo Mode (same
   message as above)
3. Create ad-hoc epic:
   ```
   TaskCreate(
     subject: "Ad-hoc: <first-task-subject> + N more",
     description: "Auto-created epic for team execution",
     activeForm: "Implementing tasks as team",
     metadata: { type: "epic", priority: 1 }
   )
   ```
4. Re-parent eligible tasks:
   `TaskUpdate(taskId, metadata: { parent_id: "<epicId>" })`
5. Proceed to **Swarm Mode** with the new epic

## Swarm Mode

### Setup

1. Parse waves from `TaskList()`:
   - Filter tasks by `metadata.parent_id == epicId`
   - Group by dependency depth (tasks with empty blockedBy = wave 1,
     tasks blocked only by wave 1 = wave 2, etc.)
2. `TaskGet(epicId)` → extract subject + `metadata.design` as epic_context
3. Create team: `TeamCreate(team_name="swarm-<epicId>")`
   If TeamCreate fails → fall back to sequential Solo Mode:
     for each task in topological order:
       Inject task description + epic context into Solo Worker
       Prompt Template, then spawn:
       ```
       Task(
         subagent_type="general-purpose",
         prompt=<SOLO_WORKER_PROMPT with injected context>
       )
       ```
       Wait for completion, verify task status.
     Skip team cleanup (no team was created)
4. Read team config: `~/.claude/teams/swarm-<epicId>/config.json`
   → extract the team lead's `name` field for injecting into worker prompts

### Wave Loop

```
while true:
  ready_tasks = TaskList() filtered by:
    metadata.parent_id == epicId AND
    status == "pending" AND
    blockedBy is empty
  if empty → break

  for each task in ready_tasks:
    task_detail = TaskGet(taskId) → description
    Spawn worker via Task tool (see Worker Spawn below)

  Wait for all workers to complete (messages + idle notifications)
  Verify: TaskList() filtered by parent → check completed count

  # Recover stuck tasks before next wave
  stuck = TaskList() filtered by:
    metadata.parent_id == epicId AND status == "in_progress"
  for each stuck task not in just-completed set:
    TaskUpdate(stuckId, status: "pending", owner: "")
    TaskUpdate(stuckId, metadata: { notes: "Released: worker failed in wave N" })

# Check if all children completed
all_children = TaskList() filtered by metadata.parent_id == epicId
if all completed → TaskUpdate(epicId, status: "completed")
Shutdown all teammates via SendMessage(type="shutdown_request")
TeamDelete
```

### Worker Spawn

For each ready task, spawn via Task tool:

```
Task(
  subagent_type="general-purpose",
  team_name="swarm-<epicId>",
  name="worker-<taskId>",
  prompt=<WORKER_PROMPT>
)
```

### Worker Prompt Template

Before spawning, inject the team lead's actual name (from team
config) into `<team-lead-name>` in the prompt template below.

```
You are a swarm worker. Implement task <task-id>.

## Your Task
<task description from TaskGet>

## Epic Context
<epic subject + design field summary>

## Protocol

1. FIRST: Claim your task:
   TaskUpdate(taskId, status: "in_progress", owner: "worker-<task-id>")
   If claim fails, someone else took it. Report and stop.

2. Read full context:
   TaskGet(taskId)

3. Implement the work described in the task.

4. When done, complete the task:
   TaskUpdate(taskId, status: "completed")

5. Send completion message to team lead:
   Use SendMessage(type="message", recipient="<team-lead-name>",
     content="Completed <task-id>: <brief summary>",
     summary="Completed <task-id>")

6. Wait for shutdown request from team lead.
   When received, approve it.

## Rules
- Only modify files described in your task
- If you hit a file conflict or blocker, report it via
  SendMessage instead of forcing through
- Do NOT work on other tasks after completing yours
```

### Solo Worker Spawn

For standalone or single-child tasks, spawn via Task tool:

```
Task(
  subagent_type="general-purpose",
  prompt=<SOLO_WORKER_PROMPT>
)
```

### Solo Worker Prompt Template

```
You are an implementation worker. Implement task <task-id>.

## Your Task
<task description from TaskGet>

## Context
<parent epic subject + design field summary, if available>

## Protocol

1. Read any files referenced in the task to understand current state.

2. Implement the work described in the task.

3. When done, complete the task:
   TaskUpdate(taskId="<task-id>", status="completed")

## Rules
- Only modify files described in or implied by the task
- If you hit a blocker, stop and report it in task metadata:
  TaskUpdate(taskId="<task-id>", metadata={ notes: "<blocker>" })
- Do NOT work on other tasks
```

### Wave Completion Detection

After spawning a wave of workers:
1. Track: spawned_count = N, completed_count = 0
2. As each worker sends completion message → completed_count++
3. When completed_count == N → wave done, proceed to next
4. If a worker goes idle WITHOUT sending completion:
   - Check `TaskList()` filtered by parent
   - If task still in_progress → worker is stuck/crashed
   - Log stuck task, decrement expected count
   - If all non-stuck workers done → proceed to next wave
5. Between waves: briefly report progress
   ("Wave N complete: M/N tasks done, K stuck")

### Parallel Spawning

CRITICAL: When spawning multiple workers for a wave, spawn ALL
of them in a SINGLE message using multiple Task tool calls. This
ensures true parallel execution. Sequential spawning (one per
message) makes waves run N× slower.

## Solo Mode

CRITICAL: Do NOT implement code directly on this context. Always
delegate to a Task agent using the Solo Worker Prompt Template.

1. `TaskUpdate(taskId, status: "in_progress")`
2. Read scope: `TaskGet(taskId)` → extract description + `metadata.design`
3. If parent epic (`metadata.parent_id`): `TaskGet(parentId)` for context
4. Inject task description + parent context into Solo Worker Prompt Template
5. Spawn worker (see Solo Worker Spawn above):
   ```
   Task(
     subagent_type="general-purpose",
     prompt=<SOLO_WORKER_PROMPT with injected context>
   )
   ```
6. On completion: verify via `TaskGet(taskId)` status is completed
7. Report results

## Error Handling

**No work found:**
- No task and no plan file → suggest `/research`

**Worker failures:**
- Claim fails (TaskUpdate errors) → skip task, report
- Worker goes idle without completing task → mark as stuck
- Worker reports file conflict → log in task metadata.notes, skip

**Wave-level recovery:**
- If some tasks in a wave fail but others succeed,
  still check `TaskList()` — downstream tasks may be unblocked
  by the successful ones
- Only abort entirely if ALL tasks in a wave fail

**Reporting:**
After all waves complete (or abort), report:
- Total tasks: N completed, M stuck, K failed
- Stuck task IDs (still in_progress)
- Whether epic was closed or left open
