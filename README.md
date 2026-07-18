# Agent Workflow Configuration

Harness-agnostic coding-agent workflow config with shared
instructions, rules, skills, and adapter-specific settings for Claude
Code, Pi, and Codex.

## Install

```sh
./install.sh claude   # install Claude Code adapter
./install.sh pi       # install Pi adapter
./install.sh codex    # install Codex adapter
./install.sh all      # install all adapters
```

Installer lifecycle commands:

```sh
./install.sh dry-run pi  # report changes and conflicts without writing
./install.sh doctor pi   # check sources, tools, and symlink support
./install.sh validate pi # verify installed links and configuration
./install.sh unlink pi   # remove only links owned by this checkout
```

Installation preflights every destination before writing. Existing files and
foreign symlinks are rejected and left untouched. Pi installs prune stale
extension links owned by this checkout. Codex's mutable `config.toml` is copied
only when absent and preserved thereafter.

Environment overrides:

- `CLAUDE_CONFIG_DIR` — default `~/.claude`
- `PI_CONFIG_DIR` — default `~/.pi/agent`
- `CODEX_CONFIG_DIR` — default `~/.codex`
- `CODEX_AGENTS_DIR` — default `~/.agents`
- `BLUEPRINT_DIR` — default `~/workspace/blueprints`

## Prerequisites

- `git`
- Graphite CLI (`gt`) for explicit stacked branch / PR skills
- GitHub CLI (`gh`) for PR and issue metadata
- Node.js for config validation and Pi extensions
- Python 3 for Claude statusline only
- macOS Keychain only for Claude quota statusline enrichment
- Codex CLI (`codex`) for the Codex adapter
- Rust/Cargo for the Pi Context Guard core
- [mise](https://mise.jdx.dev/) for the pinned Bun toolchain
- [just](https://just.systems/) for local development commands

## Development

```sh
mise install
bun install --frozen-lockfile
just check
```

`just check` is non-mutating. It validates shell syntax, skill frontmatter and
references, Biome lint rules, TypeScript, Rust formatting and lints, and the
Rust and Bun tests.

## Layout

```text
AGENTS.md                  # repository-only instructions
CLAUDE.md                  # repository Claude compatibility entrypoint
global/
  AGENTS.md                # shared global instructions
  CLAUDE.md                # globally installed Claude entrypoint
install.sh                 # harness-aware installer
bin/blueprint              # portable blueprint state CLI
bin/git-surgeon.ts         # deterministic selective-hunk Git CLI
bin/validate-skills.ts     # repository skill schema/reference validator
Cargo.toml                  # Rust workspace for vendored helper binaries
crates/context-guard/       # Pi Context Guard Rust core
rules/                     # shared coding/workflow rules
skills/                    # Agent Skills packages
harnesses/
  claude/
    settings.json          # Claude Code settings
    statusline.py          # Claude Code statusline
    hooks/                 # Claude Code hooks
  pi/
    settings.json          # Pi settings
    keybindings.json       # Pi TUI keybindings
    tui.json               # Pi TUI footer/icon colors
    effort.json            # Pi per-model thinking defaults
    extensions/            # Pi extensions
  codex/
    config.toml            # Codex CLI baseline settings
    hooks.json             # Codex hook registration
    hooks/                 # Codex hook scripts
```

## Shared config

Portable across harnesses:

- `global/AGENTS.md` — global instructions installed for each harness
- `AGENTS.md` — repository-only instructions layered over the global file
- `rules/*.md` — style, tests, comments, PR workflow, context budget
- `skills/*/SKILL.md` — Agent Skills-compatible workflow packages
- `bin/blueprint` — opt-in proposals, reviews, and reports

Blueprints are durable artifacts created only by explicitly invoked artifact
skills. Ordinary coding and PR workflows do not create them:

```sh
blueprint create proposal "topic"
blueprint create review "topic"
blueprint create report "topic" --kind context
blueprint find --type proposal,review,report --all
blueprint archive <exact-or-unique-target>
```

New `spec` and `plan` creation is rejected. Existing files remain findable and
archivable for compatibility.

## Claude Code adapter

Installed by `./install.sh claude` into `~/.claude`:

- links `global/CLAUDE.md`, `global/AGENTS.md`, `rules/`, `skills/`
- links `harnesses/claude/settings.json` as `settings.json`
- links Claude statusline and hooks
- installs `blueprint` and `git-surgeon` to `~/.local/bin`

Claude-specific features retained outside shared skills:

- Claude Code hooks and statusline protocol
- Claude plugin settings

Shared skills avoid native task/team dependencies. Blueprints remain optional
unless an artifact skill is explicitly invoked.

## Pi adapter

Installed by `./install.sh pi` into `~/.pi/agent`:

- links `global/AGENTS.md`, `rules/`, `skills/`
- links `harnesses/pi/settings.json` as `settings.json`
- links Pi `keybindings.json`, `tui.json`, and `effort.json` when present
- links Pi extensions named in `settings.json`, plus shared extension support, and prunes stale owned extension links
- installs `blueprint` and `git-surgeon` to `~/.local/bin`
- builds `crates/context-guard` and links `context-guard` to `~/.local/bin`

Pi uses `/skill:<name>` commands, for example:

```text
/skill:commit
/skill:submit
/skill:vibe <change>
/skill:converge <change>
/skill:research
/skill:review
```

Direct aliases like `/commit` can be added later with a Pi extension.

## Codex adapter

Installed by `./install.sh codex` into `~/.codex` and `~/.agents`:

- copies `harnesses/codex/config.toml` as a baseline to `~/.codex/config.toml`
- links `harnesses/codex/hooks.json` and `harnesses/codex/hooks/*`
- links `global/AGENTS.md` and `rules/` into `~/.codex` as reference files
- links shared `skills/` as `$HOME/.agents/skills`
- links shared `rules/` as `$HOME/.agents/rules`
- installs plugins declared in `harnesses/codex/packages.json`
- installs `blueprint` and `git-surgeon` to `~/.local/bin`

If `~/.codex/config.toml` already exists as a real file, the installer preserves
it. Codex may append local runtime state such as project trust, hook trust
hashes, and UI notices to the installed copy; those tables are intentionally
not checked into this repo.

Codex reads repository `AGENTS.md` files automatically. Shared skills are
installed through Codex's user skill path and can be invoked with
`$vibe <change>`, `$converge <change>`, `$commit`, `$submit`, `$research`,
`$review`, and other skill names.

## Portability status

Manual artifact skills: `context`, `research`, `review`, and `diagnose`.

Direct workflows may consume artifacts but do not require or create trackers:
`implement`, `fix`, `debug`, `respond`, `split-commit`, `resume-work`, `vibe`,
and `converge`.

The Codex package manifest installs Ponytail automatically. Caveman `lite` is
provided by the shared `AGENTS.md`. Use `CODEX_SKIP_PACKAGES=1` to skip external
plugin installation, such as during an offline bootstrap.

## Rules

- `rules/style.md` — simple readable code
- `rules/comment-quality.md` — comments explain what code cannot
- `rules/test-quality.md` — tests must catch realistic bugs
- `rules/pr-workflow.md` — PR and push workflow safety
- `rules/context-budget.md` — conserve context window
- `rules/skill-editing.md` — keep skills cohesive
- `rules/blueprints.md` — portable blueprint convention
- `rules/harness-compat.md` — portability rules for shared content
