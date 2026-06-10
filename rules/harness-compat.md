# Harness Compatibility

Shared instructions and skills must be portable across harnesses.

## Portable State

- Blueprints are the source of truth for specs, plans, reviews,
  fixes, pipeline trackers, execution tracking, and reports.
- Do not use harness-native task/team/subagent stores in shared
  skills.
- Do not keep durable workflow state only in chat history.
- Chat may carry approval or feedback, but blueprints remain the durable
  artifact. Record approval history and revisions in the relevant
  blueprint before continuing.

## Blueprint Mapping

| Need                      | Portable mechanism                                                           |
| ------------------------- | ---------------------------------------------------------------------------- |
| long-lived work item      | `blueprint create <type> <topic>`                                            |
| status                    | `status:` frontmatter                                                        |
| design / findings / notes | blueprint body sections                                                      |
| resume                    | `blueprint find --type ... [--match ...]`                                    |
| dependency order          | ordered phases in blueprint body                                             |
| review/fix/report links   | `blueprint link <file> <source-slug>`                                        |
| sub-work                  | sequential phases in the current session                                     |
| invoking another skill    | read `skills/<name>/SKILL.md` and follow it inline                           |

## Tool Names

Use portable file/shell tools in shared skills:

- `Bash`
- `Read`
- `Write`
- `Edit`
- `Glob` / `Grep` where available

Do not list or depend on native task/team/subagent tools in shared
skill frontmatter or skill bodies. Keep workflow state in blueprints.

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
