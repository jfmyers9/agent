# Pi Adapter

Pi-specific settings for this workflow config.

Installed to `~/.pi/agent/` by:

```sh
./install.sh pi
```

Pi loads:

- `global/AGENTS.md`, installed as `AGENTS.md`, as global context
- `skills/` via Agent Skills discovery
- `rules/` as referenced Markdown
- `harnesses/pi/settings.json` for model, package, and extension defaults
- `harnesses/pi/keybindings.json` for Emacs-style editor/session shortcuts
- `harnesses/pi/tui.json` for status/footer icon, color, compact-mode, and usage-bar preferences
- `harnesses/pi/effort.json` for read-only per-model thinking defaults used by `/effort`
- `harnesses/pi/xsettings.toml` for Code Mode, deferred tools, and subagent settings
- `harnesses/pi/extensions/` as global Pi extension sources
- `npm:pi-lens` for AST/LSP/code-intelligence checks
- `npm:@dreki-gg/pi-context7@0.2.0` as reviewed docs lookup tools
- `bin/blueprint` as a shared CLI

Adopted Pi settings from Luan's config:

- quiet startup and reduced terminal progress noise
- built-in `dark` theme selected explicitly
- explicit OpenAI GPT and Anthropic Claude model cycle (`gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`)
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
- `codex-native/compaction/` — uses OpenAI Responses native compaction for compatible OpenAI and Codex sessions, persists the opaque compacted window for replay, and falls back to Pi compaction on failure.
- `clear.ts` — `/clear` starts a fresh session after the current turn; `ctrl+shift+l` queues it.
- `effort.ts` — `/effort [level]` stores per-model thinking effort in the current Pi session; `effort.json` supplies defaults only.
- `fileops/` — replaces the built-in local file workflow with `read`, `search`, `find`, `write`, and a configurable `edit` tool. Default edit mode is hashline.
- `apply-patch/` — registers Codex's `apply_patch` format for GPT models and switches GPT sessions away from `edit`/`write`.
- `prompt-storage/` — local prompt stash/history. Shortcuts: `alt+s` stash current draft, `ctrl+alt+s` pop a stash, `ctrl+r` search previous prompts.
- `vim/` — replaces the editor with Vim-style modal editing. Remove it from `settings.json`'s `extensions` list, then reinstall/reload Pi, to disable it.
- `skillful/` — supports `$skill-name` references with autocomplete/highlighting and registers a `skill` tool that reads current instructions on every invocation while keeping `/skill:<name>` commands available.
- `system-prompt/` — renders the base prompt from tool guidelines, context files, skills, cwd, date, and timezone. Load structured context contributors before it and append-only contributors, such as `convergence-loop/`, after it.
- `token-burden/` — reports prompt/session token categories, tool burden, and skill burden.
- `tui/` — owns Pi footer/editor chrome for cwd, git, model/thinking, context, tokens, cost, and local `/usage-bars [on|off|toggle]` rendering.
- `spawn/` — provides `/spawn`, `spawn_lane`, `spawn_list`, and `spawn_map` for bounded Pi/shell/command lanes.
- `fork-split.ts` — keeps the current session in place when `/fork` is used and opens the selected fork in a new tmux split.
- `code-mode/` — composes existing file, shell, and skill tools through JavaScript `exec` and `wait`.
- `tool-search/` — discovers and activates deferred Context Guard, documentation, and terminal-lane tools.
- `subagents/` — concurrent nested Pi sessions with messaging, follow-up tasks, interrupts, and `/subagents` for inspection.
- `runtime-support/` — loads shared package UI support and `/xsettings` once.

Code Mode, Tool Search, Subagents, and XSettings are pinned npm dependencies in
the root package manifest and lockfile. Local adapters load their extension
entrypoints; do not add the same packages to Pi's `packages` list. Install with
`./install.sh pi` to link the adapters and settings and build Code Mode's native
runtime at the source revision recorded by its package. The runtime is cached
under Pi's agent directory; `PI_CODE_MODE_HOST_BINARY` can select a prebuilt
binary for an offline workstation or devbox.

Tracked Bun patches preserve session-specific tool ownership and prevent child
startup from restoring lifted or deferred tools. A dependency override plus the
root postinstall script removes shadowing bundled Code Mode copies from the two
consumer packages. Keep these patches until upstream includes the fixes; the
composition tests cover concurrent sessions and parent/sibling tool isolation.

Our `fileops/` continues to own read, search, find, write, and hashline editing.
Our `apply-patch/` owns structured patches, validates them before writing, shares
file mutation queues, and reports completed paths after partial filesystem
failures. Upstream's current `pi-fileops` is patch-only and is not installed over
either extension. Mutation queues coordinate operations within one Pi process;
they do not lock out other editors or terminal processes.

Core file, shell, and skill tools run under `exec`; their JavaScript results
contain `content` and `details`. Nested calls retain argument validation, shell
output limits, error reporting, Context Guard wrapping, and disabled-tool checks.
`tool_search` stays direct and loads less common tools on demand. Change the
lists through `/xsettings` and start a new session after changing tool placement.

Subagents use four slots including the root and allow two levels of children.
`/spawn` still opens independent terminal lanes. Forking or navigating the tree
while subagents are active is blocked until they finish or are interrupted.
The Agent Hub uses a terminal fullscreen overlay, so it works over SSH without a
browser. No Anthropic helper or Plannotator integration is loaded.

Retired local extension names:

- `skill-dollar/` is replaced by `skillful/`.
- `pi-vim/` is replaced by `vim/`.
- `usage-hud/` is replaced by `tui/` as the sole footer owner.
- `mac-system-theme.ts` is replaced by the explicit `theme: "dark"` setting.

Prompt storage is local-only and stores stashes/history in `${XDG_STATE_HOME:-~/.local/state}/pi/prompt-storage.sqlite`. Slash commands are excluded from history by default. Delete that SQLite file to clear prompt-storage data.

Context7 is installed as a pinned reviewed Pi package. It registers `context7_resolve_library_id`, `context7_get_library_docs`, and `context7_get_cached_doc_raw`. API key is optional; set `CONTEXT7_API_KEY` for higher limits. Its cache lives under `~/.pi/agent/extensions/context7/cache/`. Pi packages execute extension code with full local privileges, so bump package versions only after review.

Skills are available as `/skill:<name>` and `$skill-name` references by default.

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

`cg_status` reports measured raw, indexed, returned, and omitted bytes plus
failures, latency percentiles, indexed-store size, and lifetime telemetry.
Execution output uses unique internal source IDs, so repeated display labels do
not overwrite history. Old execution sources are removed by age and store-size
retention limits.

Run the replay corpus to inspect savings, retrieval recall, latency, and storage
growth across small output, large logs, long lines, Unicode, failures, mixed
streams, and repeated labels:

```sh
cargo test -p context-guard --test replay_benchmark -- --nocapture
```

Context Guard stores searchable command and fetched content plus operational
telemetry. It does not infer semantic memory, inject prompts, or create resume
snapshots.

The Rust core remains a one-shot process with SQLite storage; the replay report
is the baseline for deciding whether daemon complexity is ever warranted.
Command deny-pattern parsing is defense in depth, not a sandbox or authorization
boundary.

`ct` is different: it is Luan's broader Rust CLI. This config no longer requires
`ct` for `edit` or TUI usage bars.

Use `/skill:artifact` when saving a durable plan, review, context map, or report.
`/skill:review` returns findings in chat. Ordinary coding and PR work can consume
supplied documents without modifying them or requiring a workflow sequence.
`blueprint archive <exact-target>` archives one artifact when requested.

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
