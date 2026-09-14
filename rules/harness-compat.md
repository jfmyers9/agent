# Harness Compatibility

Shared instructions and skills must be portable across harnesses.

- Use chat and the working tree for ordinary work. Save artifacts only when
  explicitly requested; existing documents are optional inputs, not trackers.
- Do not require harness-native task/team stores or persistent session state.
- Use portable shared-skill tool names: `Bash`, `Read`, `Write`, `Edit`, `Glob`,
  and `Grep`. Do not list native task/team tools in shared frontmatter.
- Avoid harness-specific config paths except in adapter documentation.
- Skill directories must match `name`, use lowercase letters/numbers/hyphens,
  and have descriptions specific enough to route the intended task.
- Shared frontmatter may use `argument-hint`, `user-invocable`, and
  `disable-model-invocation`, which the installed adapters understand.

Use `bun run check:skills` as this repository's authoritative schema check.
For durable storage commands, see `@rules/blueprints.md`.
