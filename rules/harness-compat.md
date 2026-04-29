# Harness Compatibility

Prefer portable mechanisms in shared instructions and skills.

## Portable State

- Blueprints are the cross-harness source of truth for specs,
  plans, reviews, and reports.
- Harness-native task stores may mirror blueprint state, but must not
  be the only durable record.

## Tool Names

Shared skills may mention harness-native tools only as optional fast
paths. If a tool is unavailable, use the closest portable fallback:

| Need | Preferred portable fallback |
|------|-----------------------------|
| persistent task | blueprint file/frontmatter |
| subagent/team | sequential main-thread execution |
| custom command | `/skill:<name>` |
| statusline/hook | harness adapter extension/script |

## Paths

- Do not hardcode `~/.claude` or `~/.pi/agent` in shared content
  unless explicitly documenting an adapter default.
- Prefer repo-relative paths or installed skill-relative paths.

## Skills

Skills should follow the Agent Skills standard:

- directory name matches `name`
- lowercase letters, numbers, hyphens only
- specific description
- helper scripts/assets referenced relative to the skill directory
