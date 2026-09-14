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
- Rust/Cargo and initial network access for the pinned Pi Code Mode runtime
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
bin/blueprint              # portable artifact storage CLI
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
    xsettings.toml         # Pi tool composition, discovery, and subagents
    extensions/            # Pi extensions
  codex/
    config.toml            # Codex CLI baseline settings
    hooks.json             # Codex hook registration
    hooks/                 # Codex hook scripts
```

## Shared config

Portable across harnesses:

- `global/AGENTS.md` — global instructions installed for each harness
- `AGENTS.md` — repository-only instructions
- `rules/*.md` — style, tests, comments, PR workflow, context budget
- `skills/*/SKILL.md` — Agent Skills-compatible workflow packages
- `bin/blueprint` — opt-in proposals, reviews, and reports

Artifacts are saved only when requested, using the `artifact` skill or an
explicit destination. Plans, reviews, context maps, and diagnoses are ordinary
Markdown inputs to a later prompt. They carry no approval or execution state.
The blueprint CLI provides optional naming, discovery, and archival:

```sh
blueprint create proposal "topic" --status complete
blueprint create review "topic"
blueprint create report "topic" --kind context
blueprint find --type proposal,review,report --all
blueprint archive <exact-or-unique-target>
```

Existing documents remain readable. Saving does not require a commit or push.

## Claude Code adapter

Installed by `./install.sh claude` into `~/.claude`:

- links `global/CLAUDE.md`, `global/AGENTS.md`, `rules/`, `skills/`
- links `harnesses/claude/settings.json` as `settings.json`
- links Claude statusline and hooks
- installs `blueprint` and `git-surgeon` to `~/.local/bin`

Claude-specific features retained outside shared skills:

- Claude Code hooks and statusline protocol
- Claude plugin settings

Shared skills avoid native task/team dependencies. Saving artifacts is explicitly requested and independent of coding work.

## Pi adapter

Installed by `./install.sh pi` into `~/.pi/agent`:

- links `global/AGENTS.md`, `rules/`, `skills/`
- links `harnesses/pi/settings.json` as `settings.json`
- links Pi `keybindings.json`, `tui.json`, and `effort.json` when present
- links Pi extensions named in `settings.json`, plus shared extension support, and prunes stale owned extension links
- installs `blueprint` and `git-surgeon` to `~/.local/bin`
- builds `crates/context-guard` and links `context-guard` to `~/.local/bin`
- installs pinned package dependencies and builds the matching Code Mode runtime

Pi composes the existing file, shell, and skill tools through `exec`, discovers
less common tools through `tool_search`, and runs nested workers through
`spawn_agent`. `/subagents` opens their terminal Agent Hub; `/spawn` retains the
independent tmux-lane workflow. The local fileops and patch implementations keep
their existing responsibilities. See the [Pi adapter](harnesses/pi/README.md) for
tool ownership, settings, and remote/offline setup.

Pi uses `/skill:<name>` commands, for example:

```text
/skill:commit
/skill:submit
/skill:artifact <what to save>
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
`$commit`, `$submit`, `$artifact`, `$review`, and other skill names.

## Skills

- `artifact` — save a requested plan, review, context map, diagnosis, or other note.
- `review` — assess a code change and return evidence-backed findings in chat.
- `respond` — validate PR feedback, apply requested fixes, and post authorized replies.
- `commit`, `gt`, `submit`, `split-commit`, `git-surgeon` — specialized Git and stack operations.
- `improve-rust-tests` — improve meaningful Rust behavior coverage and test structure.
- `writing-skills` — edit this repository's skills and validate their schema and references.

Implementation, debugging, and cleanup use ordinary prompts. Any task can consume
an explicitly supplied document without updating it or following a skill sequence.

## Rules

- `rules/style.md` — simple readable code
- `rules/comment-quality.md` — comments explain what code cannot
- `rules/test-quality.md` — tests must catch realistic bugs
- `rules/pr-workflow.md` — PR and push workflow safety
- `rules/context-budget.md` — conserve context window
- `rules/skill-editing.md` — keep skills cohesive
- `rules/blueprints.md` — portable blueprint convention
- `rules/harness-compat.md` — portability rules for shared content
