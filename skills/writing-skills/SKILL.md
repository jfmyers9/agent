---
name: writing-skills
description: >
  Create or edit Agent Skills in this repository with precise routing,
  portable tools, cohesive instructions, and repository validation. Use for
  actual changes under `skills/`, not general advice about skill design.
argument-hint: "<skill-name-or-path> [description]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Writing Skills

Write focused skills that add useful behavior beyond ordinary agent work.

@rules/skill-editing.md applies.

Use the supplied skill name or path as the target and the optional description
as the desired capability. For new skills, use `skills/<name>/SKILL.md` with a
lowercase kebab-case name. For updates, read the entire existing skill first.

1. Read repository instructions and search references to the target in skills,
   rules, documentation, and tests. Understand its routing and side effects
   before editing. Verify referenced files, skills, and commands exist.
2. Keep frontmatter consistent with the body:
   - Match `name` to the directory exactly.
   - Describe the capability and when to invoke it; distinguish nearby skills
     only where routing would otherwise be ambiguous.
   - Document every argument advertised by `argument-hint`; omit it when unused.
   - Use portable tool names such as `Bash`, `Read`, `Write`, `Edit`, `Glob`, and
     `Grep` in `allowed-tools`, consistent with the required operations.
   - Use `user-invocable: true` and `disable-model-invocation: true` for skills
     intended only for explicit invocation.

   The repository supports adapter extension fields; `bun run check:skills`
   is the authoritative schema check.

3. Integrate changes where they belong in the workflow. Remove duplication,
   obsolete routing, and unnecessary ceremony. Specify useful inputs, scope,
   side effects, verification, and output without restating global agent
   instructions. Keep examples neutral and prose wrapped near 80 characters.
4. Read the complete result and inspect the diff for contradictions, dangling
   references, mismatched arguments, and unrelated changes. Update affected
   documentation and meaningful contract tests with the changed behavior.
5. Run `bun run check:skills` and relevant tests. For shared skill contracts or
   schema changes, run:

   ```sh
   bun test tests/workflow-contracts.test.ts tests/skill-validator.test.ts
   ```

Report the changed skills, important behavior changes, and validation results.
