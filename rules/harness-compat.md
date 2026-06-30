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
| report | `blueprint create report <topic>` |
| discovery | `blueprint find --type ... [--match ...]` |
| linkage | `blueprint link <file> <source-slug>` |
| archival | `blueprint archive [slug]` |

## Tools And Paths

Use portable shared-skill tool names: `Bash`, `Read`, `Write`, `Edit`, `Glob`,
and `Grep`. Do not list native task/team tools in shared skill frontmatter.
Avoid harness-specific config paths except in adapter documentation.

Skill directories must match `name`, use lowercase letters/numbers/hyphens,
and keep descriptions specific enough to avoid routing ordinary questions.
