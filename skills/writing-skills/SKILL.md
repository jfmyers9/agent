---
name: writing-skills
description: >
  Create or update repository Agent Skills with precise routing metadata,
  portable tools, cohesive workflows, and verification. Use when asked to add,
  rewrite, or improve a skill under `skills/`.
argument-hint: "<skill-name-or-path> [description]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Writing Skills

Create or revise a portable skill without weakening its behavioral contracts.

@rules/skill-editing.md and @rules/harness-compat.md apply.

## Arguments

- `<skill-name-or-path>` — new kebab-case name or existing skill/path.
- `[description]` — optional capability and intended invocation context.

For an update, infer the current description from the target and use the user's
request as the desired delta. Ask for missing information only when the target
or required behavior cannot be determined safely.

## Workflow

### 1. Resolve The Target

- Treat an existing name or `SKILL.md` path as an update.
- For a new skill, validate a lowercase kebab-case name and use
  `skills/<name>/SKILL.md`.
- If several targets match, ask which one; do not guess or overwrite.
- Read repository instructions before creating directories or editing files.

### 2. Discover Existing Contracts

For an update, read the entire target from frontmatter through its final line.
For both new and existing skills:

1. read two or three nearby skills with similar side effects or routing;
2. search tests, documentation, and other skills for references to the target,
   exact phrases, flags, and workflow guarantees;
3. identify applicable rules and verify every referenced skill, command, and
   helper actually exists; and
4. record the routing boundary, authorized side effects, required outputs, and
   behaviors that must remain stable unless the user requested a change.

Do not append new behavior before understanding how it fits the existing
workflow.

### 3. Design Frontmatter

Use only fields the repository supports:

```markdown
---
name: example-skill
description: >
  Perform a specific capability. Use when the user requests its narrow,
  distinguishable workflow.
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "<required> [--optional]"
---
```

- Make `name` match the directory exactly.
- Describe both what the skill does and when it should route. Include a negative
  boundary when a neighboring skill is easy to confuse; avoid keyword lists in
  place of a semantic description.
- Include `argument-hint` only when the skill accepts arguments, and document
  every argument in the body.
- Grant the smallest portable `allowed-tools` set: inspection usually needs
  `Bash, Read, Glob, Grep`; add `Edit` or `Write` only for file changes.
- Never list harness-native task, team, or subagent tools in shared frontmatter.
- Add `user-invocable: true` and `disable-model-invocation: true` when the skill
  must run only through explicit invocation, including opt-in durable artifact
  skills. Preserve these fields on existing explicit-only skills.

Omit optional fields that add no constraint. If a workflow needs an optional
tool outside the portable set, either leave tools unrestricted or specify a
portable fallback; do not declare a tool set that makes the workflow
impossible.

### 4. Write A Cohesive Workflow

For a new skill, create the directory and a concise `SKILL.md`. For an update,
integrate changes into the workflow step where they belong, remove duplication,
and keep section order aligned with execution order.

Use this structure only where each section adds value:

1. one imperative purpose statement;
2. applicable rule references;
3. arguments and defaults;
4. ordered workflow with inputs, safety boundaries, verification, and output;
   and
5. exceptional behavior or blockers near the step that can trigger them.

Write direct imperative instructions. Prefer observable decision criteria over
subjective language such as "best" or "appropriate." Define what the agent may
change, when it must ask, how it preserves unrelated work, and what completion
requires. Give exact commands only when they are stable and verified; otherwise
instruct the agent to inspect current project documentation or CLI help.

Keep ordinary workflows in chat and the working tree. Only skills explicitly
invoked for durable artifacts may create blueprints; when one does, follow
`@rules/blueprints.md` and `@rules/human-approval.md`. Do not add artifact side
effects to unrelated skills. Make artifact workflows preserve and validate
frontmatter, derive link targets from the source file's full stem, and inspect
the whole blueprint repository before committing. They must stop on an existing
index or unrelated project changes because `blueprint commit` stages the
project subtree and commits the existing index.

### 5. Verify The Result

Read the final file top to bottom and check:

- valid YAML frontmatter and matching name/directory;
- a narrow, accurate routing description;
- argument, tool, invocation, and side-effect metadata consistent with the
  body;
- imperative instructions in workflow order, without contradictions,
  duplicated rules, dangling references, or stale pseudo-templates;
- preserved behavior contracts and unrelated user changes;
- readable Markdown with prose wrapped near 80 characters; and
- targeted repository tests or validators for skill contracts.

Inspect the final diff and report files changed, key routing or workflow
decisions, and validation results. Do not create a blueprint unless the user
explicitly invoked an artifact skill.
