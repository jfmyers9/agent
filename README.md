# Agent Workflow Configuration

Harness-agnostic coding-agent workflow config with shared
instructions, rules, skills, and adapter-specific settings for Claude
Code and Pi.

## Install

```sh
./install.sh claude   # install Claude Code adapter
./install.sh pi       # install Pi adapter
./install.sh all      # install both
```

Environment overrides:

- `CLAUDE_CONFIG_DIR` — default `~/.claude`
- `PI_CONFIG_DIR` — default `~/.pi/agent`
- `BLUEPRINT_DIR` — default `~/workspace/blueprints`

## Prerequisites

- `git`
- Graphite CLI (`gt`) for stacked branch / PR workflow
- GitHub CLI (`gh`) for PR and issue metadata
- Python 3 for Claude statusline only
- macOS Keychain only for Claude quota statusline enrichment

## Layout

```text
AGENTS.md                  # shared global instructions
CLAUDE.md                  # Claude compatibility entrypoint
install.sh                 # harness-aware symlink installer
bin/blueprint              # portable blueprint state CLI
rules/                     # shared coding/workflow rules
skills/                    # Agent Skills packages
harnesses/
  claude/
    settings.json          # Claude Code settings
    statusline.py          # Claude Code statusline
    hooks/                 # Claude Code hooks
  pi/
    settings.json          # Pi settings
    extensions/            # Pi extensions
```

## Shared config

Portable across harnesses:

- `AGENTS.md` — global instructions
- `rules/*.md` — style, tests, comments, PR workflow, context budget
- `skills/*/SKILL.md` — Agent Skills-compatible workflow packages
- `bin/blueprint` — file-backed specs, plans, reviews, reports

Blueprints are the portable source of truth for long-lived state:

```sh
blueprint create spec "topic"
blueprint create plan "topic"
blueprint create review "topic"
blueprint create report "topic"
blueprint find --type plan,spec,review
blueprint archive <slug>
```

## Claude Code adapter

Installed by `./install.sh claude` into `~/.claude`:

- links `CLAUDE.md`, `AGENTS.md`, `rules/`, `skills/`
- links `harnesses/claude/settings.json` as `settings.json`
- links Claude statusline and hooks

Claude-specific features retained outside shared skills:

- Claude Code hooks and statusline protocol
- Claude plugin settings

Shared skills intentionally avoid native task/team paths and use
blueprints for durable workflow state in every harness.

## Pi adapter

Installed by `./install.sh pi` into `~/.pi/agent`:

- links `AGENTS.md`, `rules/`, `skills/`
- links `harnesses/pi/settings.json` as `settings.json`
- links `harnesses/pi/extensions/*` into `~/.pi/agent/extensions/`
- installs `blueprint` to `~/.local/bin`

Pi uses `/skill:<name>` commands, for example:

```text
/skill:commit
/skill:submit
/skill:research
/skill:review
```

Direct aliases like `/commit` can be added later with a Pi extension.

## Portability status

Shared skills use blueprints for durable state and avoid native
Task/Team orchestration paths.

Blueprint-backed workflow skills:

- `research`, `implement`, `review`, `fix`, `vibe`
- `acceptance`, `split-commit`, `debug`, `respond`, `pr-plan`,
  `resume-work`, `report`, `archive`

Direct-action / utility skills:

- `commit`, `daily`, `gt`, `start`, `submit`, `refine`,
  `git-surgeon`, `writing-skills`

## Rules

- `rules/style.md` — simple readable code
- `rules/comment-quality.md` — comments explain what code cannot
- `rules/test-quality.md` — tests must catch realistic bugs
- `rules/pr-workflow.md` — Graphite-first PR workflow
- `rules/context-budget.md` — conserve context window
- `rules/skill-editing.md` — keep skills cohesive
- `rules/blueprints.md` — portable blueprint convention
- `rules/harness-compat.md` — portability rules for shared content
