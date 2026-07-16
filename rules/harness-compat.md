# Harness Compatibility

Shared instructions and skills must be portable across harnesses.

## State

- Use chat and the working tree for ordinary, session-local work.
- Use blueprints only for explicitly requested durable artifacts.
- Existing proposals, reviews, reports, and legacy specs/plans may be optional
  workflow inputs.
- Do not require harness-native task/team stores or blueprint trackers.

## Portable Artifact Operations

| Need | Mechanism |
| ---- | --------- |
| proposal | `blueprint create proposal <topic>` |
| review | `blueprint create review <topic>` |
| report | `blueprint create report <topic> --kind <context|diagnosis>` |
| discovery | `blueprint find --type ... [--match ...|--exact ...]` |
| linkage | `blueprint link <file> <source-slug>` |
| archival | `blueprint archive <exact-or-unique-target>` |

## Tools And Paths

Use portable shared-skill tool names: `Bash`, `Read`, `Write`, `Edit`, `Glob`,
and `Grep`. Do not list native task/team tools in shared skill frontmatter.
Avoid harness-specific config paths except in adapter documentation.

A deliberately invoked orchestration skill may require one-shot fresh workers
when context isolation is its core behavior. Such a skill must set both
`disable-model-invocation: true` and `user-invocable: true`; only then may it
set `metadata.requires-fresh-workers: true` and omit `allowed-tools` instead of
naming native tools. Describe the capability generically, pass compact stage
packets, and persist no native task, team, lane, or session state. Every launch
must create a new context, be waitable, and return one terminal result. Stop
clearly when the harness cannot meet that contract; do not silently weaken the
workflow to same-context execution.

Skill directories must match `name`, use lowercase letters/numbers/hyphens,
and keep descriptions specific enough to avoid routing ordinary questions.

Shared frontmatter may also use `argument-hint`, `user-invocable`, and
`disable-model-invocation`, which the installed adapters understand even though
some generic Agent Skills validators reject extension fields. Use
`bun run check:skills` as this repository's authoritative schema check.
