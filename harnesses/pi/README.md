# Pi Adapter

Pi-specific settings for this workflow config.

Installed to `~/.pi/agent/` by:

```sh
./install.sh pi
```

Pi loads:

- `AGENTS.md` as global context
- `skills/` via Agent Skills discovery
- `rules/` as referenced Markdown
- `harnesses/pi/settings.json` for model, package, and extension defaults
- `harnesses/pi/keybindings.json` for Emacs-style editor/session shortcuts
- `harnesses/pi/tui.json` for status/footer icon, color, compact-mode, and usage-bar preferences
- `harnesses/pi/effort.json` for read-only per-model thinking defaults used by `/effort`
- `harnesses/pi/extensions/` as global Pi extension sources
- `npm:pi-lens` for AST/LSP/code-intelligence checks
- `npm:@dreki-gg/pi-context7@0.1.9` as reviewed docs lookup tools
- `bin/blueprint` as a shared CLI

Adopted Pi settings from Luan's config:

- quiet startup and reduced terminal progress noise
- built-in `dark` theme selected explicitly
- explicit OpenAI GPT and Anthropic Claude model cycle (`gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`)
- tree navigation on double Escape
- Emacs-style movement and queueing shortcuts
- Luan's current `tui` footer/editor chrome, with provider usage bars defaulted off
- local prompt stash/history shortcuts backed by a SQLite database
- `skillful` `$skill-name` references plus the `skill` tool
- local context files as structured prompt context
- bounded `/spawn` lanes
- token-burden inspection
- Context7 documentation lookup tools via a reviewed, pinned Pi package

Feature decisions from the Luan config review are tracked in
[`../../docs/luan-feature-decisions.md`](../../docs/luan-feature-decisions.md).

Installed extensions:

- `agents-local/` — injects untracked `AGENTS.local.md` / `CLAUDE.local.md` context from cwd ancestors; `/agents-local` lists loaded files.
- `clear.ts` — `/clear` starts a fresh session after the current turn; `ctrl+shift+l` queues it.
- `effort.ts` — `/effort [level]` stores per-model thinking effort in the current Pi session; `effort.json` supplies defaults only.
- `fileops/` — replaces the built-in local file workflow with `read`, `search`, `find`, `write`, and a configurable `edit` tool. Default edit mode is hashline.
- `apply-patch/` — registers Codex's `apply_patch` format for GPT models and switches GPT sessions away from `edit`/`write`.
- `prompt-storage/` — local prompt stash/history. Shortcuts: `alt+s` stash current draft, `ctrl+alt+s` pop a stash, `ctrl+r` search previous prompts.
- `vim/` — replaces the editor with Vim-style modal editing. Remove it from `settings.json`'s `extensions` list, then reinstall/reload Pi, to disable it.
- `skillful/` — supports `$skill-name` references with autocomplete/highlighting and registers a `skill` tool that reads current instructions on every invocation while keeping `/skill:<name>` commands available.
- `system-prompt/` — renders a tested Mustache system prompt from active tools, context files, skills, cwd, date, and timezone.
- `token-burden/` — reports prompt/session token categories, tool burden, and skill burden.
- `tui/` — owns Pi footer/editor chrome for cwd, git, model/thinking, context, tokens, cost, and local `/usage-bars [on|off|toggle]` rendering.
- `spawn/` — provides `/spawn`, `spawn_lane`, `spawn_list`, and `spawn_map` for bounded Pi/shell/command lanes.
- `fork-split.ts` — keeps the current session in place when `/fork` is used and opens the selected fork in a new tmux split.
Retired local extension names:

- `skill-dollar/` is replaced by `skillful/`.
- `pi-vim/` is replaced by `vim/`.
- `usage-hud/` is replaced by `tui/` as the sole footer owner.
- `mac-system-theme.ts` is replaced by the explicit `theme: "dark"` setting.

Prompt storage is local-only and stores stashes/history in `${XDG_STATE_HOME:-~/.local/state}/pi/prompt-storage.sqlite`. Slash commands are excluded from history by default. Delete that SQLite file to clear prompt-storage data.

Context7 is installed as a pinned reviewed Pi package. It registers `context7_resolve_library_id`, `context7_get_library_docs`, and `context7_get_cached_doc_raw`. API key is optional; set `CONTEXT7_API_KEY` for higher limits. Its cache lives under `~/.pi/agent/extensions/context7/cache/`. Pi packages execute extension code with full local privileges, so bump package versions only after review.

Skills are available as `/skill:<name>` and `$skill-name` references by default.

## Ephemeral worker adapter

Orchestration skills such as `/skill:converge` need a new context and one
terminal result for every stage. From the target repository working directory,
the Pi adapter is:

```sh
pi --print --no-session "<complete stage packet>"
```

Run it once per stage and wait for the process to exit before launching the
next stage. `--no-session` prevents worker context from being persisted or
resumed. Do not use `spawn_lane` for this contract: lanes return asynchronously
and retain native task/session state.

## Context Guard core

The `context-guard` Pi extension is registered by default. Its indexing,
search, fetch, `cg_process_file`, and `exec_command(mode: "batch")` features
are backed by the vendored Rust core in `../../crates/context-guard`.

Reviewed upstream source: `luan/agents` at `ec62ad5`.

`./install.sh pi` builds the release binary and links it to
`~/.local/bin/context-guard`:

```sh
cargo build --release -p context-guard
ln -sf "$PWD/target/release/context-guard" ~/.local/bin/context-guard
```

Pi finds the core in this order:

1. `CONTEXT_GUARD_BIN=/absolute/path/to/context-guard`
2. `target/release/context-guard` or `target/debug/context-guard` under this repo
3. `context-guard` on `PATH`

If `~/.local/bin` is not on the environment used to launch Pi, set an explicit
binary path before starting Pi:

```sh
export CONTEXT_GUARD_BIN="/path/to/agent-config/target/release/context-guard"
```
Verify after restarting Pi:

```text
/cg-check
```

Expected installed output includes `[OK] Core binary: ...`. If the binary is
missing, `cg_check` and `/cg-check` still work and report a clear diagnostic;
core-backed tools remain unavailable until the binary is installed.

`ct` is different: it is Luan's broader Rust CLI. This config no longer requires
`ct` for `edit` or TUI usage bars.

Blueprints are opt-in durable artifacts, not default workflow trackers:

- `/skill:research` creates a proposal.
- `/skill:review` creates a review.
- `/skill:context` and `/skill:diagnose` create typed reports.
- `blueprint archive <exact-target>` archives one durable artifact.

Ordinary implementation, debugging, fixes, and PR work such as `/skill:respond`
use chat and the working tree. `/skill:implement` can consume an explicitly
named proposal, report, or legacy spec/plan, but does not create a tracker.

Validation:

```sh
bun install
bun run check:skills
bun run typecheck
bun run test:pi-low-risk
bun run test:pi-skillful
bun run test:pi-system
bun run test:pi-tui
bun run test:pi-token
bun run test:pi-spawn
PI_CONFIG_DIR=$(mktemp -d) ./install.sh pi
```
