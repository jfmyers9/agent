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
- `harnesses/pi/xsettings.toml` for subagent settings
- `harnesses/pi/extensions/` as global Pi extension sources
- `npm:pi-lens` for AST/LSP/code-intelligence checks
- `npm:@dreki-gg/pi-context7@0.2.0` as reviewed docs lookup tools
- `bin/blueprint` as a shared CLI

The model selector includes Fireworks DeepSeek V4.1 Flash, GLM 5.3 Flash, and
Kimi K3 when an optional OpenAI-compatible gateway is configured. Set
`PI_FIREWORKS_GATEWAY_URL` to the endpoint. Workstation launchers can set this
automatically. Alternatively, put the endpoint in
`~/.pi/agent/fireworks-gateway.json`:

```json
{ "baseUrl": "https://gateway.example.com/inference/v1" }
```

The environment variable takes precedence over the file. The endpoint must
accept requests without an Authorization header. The local file is not tracked
or managed by the installer. Select a model with `/model`
or `pi --model fireworks-gateway/accounts/fireworks/models/deepseek-v4p1-flash`.

Adopted Pi settings from Luan's config:

- quiet startup and reduced terminal progress noise
- built-in `dark` theme selected explicitly
- explicit OpenAI GPT and Anthropic Claude model cycle
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

Compaction uses Pi's built-in implementation.

Thinking levels use Pi's native `/thinking` command and `defaultThinkingLevel`
setting (currently `high`). Use `modelThinkingLevels` in `settings.json` only
when a per-model startup default is needed.

Installed extensions:

- `agents-local/` — injects untracked `AGENTS.local.md` / `CLAUDE.local.md` context from cwd ancestors; `/agents-local` lists loaded files.
- `fireworks-gateway.ts` — registers Fireworks models when an anonymous gateway endpoint is configured.
- `clear.ts` — `/clear` starts a fresh session after the current turn; `ctrl+shift+l` queues it.
- `diff-prod/` — automatically shows a production diff beside the fullscreen transcript/editor; `/diff-prod` opens the standalone overlay. See [Production diff pane](#production-diff-pane).
- `tuicr.ts` — `Ctrl+Alt+G` opens the pinned `@luan.sh/pi-tuicr` review integration. Choose uncommitted changes, a branch, commits, or a PR, then review in a fullscreen overlay. New review comments become an editor attachment and expand into your next submitted prompt; nothing is submitted automatically. This is separate from the production-only diff pane: review targets include test files. Requires the `tuicr` executable (`brew install tuicr` on macOS) and Rust for the embedded terminal bridge's first-use build. The existing runtime-support extension supplies the UI and shortcut hosts; the optional `pi-panels` package is not installed.
- `async-questions/` — `request_user_input_async` presents inline questions without blocking independent work. Answers arrive through steering; `/questions` focuses pending questions and `/questions dismiss` dismisses the oldest group without granting approval. Pending questions and submitted answers are session-local and survive resume. The existing `ask_user` remains available for multi-select and preview dialogs.
- `fast-mode.ts` — requests OpenAI priority processing by default for first-party GPT Responses routes (`openai`, including ChatGPT sign-in, and legacy `openai-codex`). `Alt+G` toggles; `/fast` shows status; `/fast on|off|toggle` changes it. The `fast` label beside the model means **priority requested**, not confirmed. Overrides persist on the current session branch across reloads; fresh sessions default on. Unsupported providers/endpoints remain unchanged, and reasoning effort is unaffected. OpenAI controls eligibility and higher cost/quota consumption. Pi's displayed cost can undercount if the provider omits its actual service tier; this extension does not modify usage accounting. Uses native request hooks, not a replacement provider; custom cross-provider routing is not supported.
- `fileops/` — replaces the built-in local file workflow with `read`, `search`, `find`, `write`, and a configurable `edit` tool. Default edit mode is hashline.
- `apply-patch/` — registers Codex's `apply_patch` format for GPT models and switches GPT sessions away from `edit`/`write`.
- `prompt-storage/` — local prompt stash/history. Shortcuts: `alt+s` stash current draft, `ctrl+alt+s` pop a stash, `ctrl+r` search previous prompts.
- `vim/` — replaces the editor with Vim-style modal editing. Remove it from `settings.json`'s `extensions` list, then reinstall/reload Pi, to disable it.
- `skillful/` — supports `$skill-name` references with autocomplete/highlighting and registers a `skill` tool that reads current instructions on every invocation while keeping `/skill:<name>` commands available.
- `system-prompt/` — renders the base prompt from tool guidelines, context files, skills, cwd, date, and timezone. Load structured context contributors before it and append-only contributors, such as `convergence-loop/`, after it.
- `token-burden/` — reports prompt/session token categories, tool burden, and skill burden.
- `tui/` — owns Pi footer/editor chrome for cwd, git, model/thinking, context, tokens, cost, and local `/usage-bars [on|off|toggle]` rendering.

The status cost is the session-wide list-price estimate, including all branches
and all nested subagents. An `agents $…` suffix shows the included worker share
when space permits; `/cost` shows the full per-agent breakdown. Worker totals
refresh while the parent is idle. Small costs retain sub-cent precision.
Request-time model prices (including cache, long-context and service-tier rates)
are preserved, not recalculated at the currently selected model's price. These
are API-equivalent estimates, not subscription invoices. Recorded tool and
summary usage is included; missing prices use the model catalog when possible,
otherwise `≥` marks an incomplete total. Unreported provider usage and historical
worker spend omitted by older checkpoints cannot be reconstructed. Independently
launched `/spawn` sessions are not descendants and are not included.
- `spawn/` — provides `/spawn`, `spawn_lane`, `spawn_list`, and `spawn_map` for bounded Pi/shell/command lanes.
- `fork-split.ts` — keeps the current session in place when `/fork` is used and opens the selected fork in a new tmux split.
- `subagents/` — concurrent nested Pi sessions with messaging, follow-up tasks, interrupts, and `/subagents` for inspection.
- `runtime-support/` — loads shared package UI support and `/xsettings` once, and gives native Code Mode/tool-search rows compact framing while preserving their renderers and expansion controls. Errors and image results retain native framing.
- `collapse-transcript/` — keeps the current run's tools and thinking visible, then folds settled activity into timed, expandable rows in fullscreen mode. Assistant prose and standalone notices remain visible; failed tools retain failure counts and their original expanded output. Regular scrollback is unchanged.

### Production diff pane

The right-hand pane defaults on for each session. It appears when tracked
production files have changes and the fullscreen terminal is at least 120 columns
wide and 8 rows high. It reserves space rather than covering the transcript,
keeps at least 72 columns for the main area, and leaves keyboard focus in the
editor. Other, higher-priority split panes take precedence.

- `/diff-prod on|off|toggle`: control the automatic pane until session restart/reload.
- `Ctrl+Alt+D` or `/diff-prod focus`: focus the pane or return to the editor.
- Arrows/`hjkl`: scroll/pan; Page Up/Down: page; `g`/`G`: top/bottom.
- `q` or Escape: return focus to the editor without hiding the pane.
- `/diff-prod`: standalone overlay, also available in narrow/regular-mode terminals.

Refresh runs after tools and turns and every three seconds (including changes
from `!`/`!!` or external editors). Turning the pane off stops its polling.
Empty diffs and automatic Git/config failures hide the pane; the explicit
overlay command reports errors. The view stays out of model context.

Both views show repository-wide staged and unstaged **tracked** changes against
HEAD, excluding common test/spec/fixture paths. Untracked files are not included.
Before the first commit, comparison uses the empty tree. Renames display as
deletion/addition so production-to-test moves still show the production deletion;
binary changes show Git's summary.

Optional `<repo>/.pi/diff-prod.json` replaces the defaults with repository-relative
Git glob exclusions:

```json
{"exclude":["**/tests/**","**/*.test.*"]}
```

`{"exclude":[]}` includes all tracked files. Defaults are in
`extensions/diff-prod/git.ts`; filtering is path-based, not language-aware.

### Native tools

Pi 1.0.0 supplies Code Mode and tool search. `settings.json` activates
`codemode` and `tool_search`; `codemode.mode: "only"` routes callable tools
through JavaScript. Install with `./install.sh pi` and restart Pi. Code Mode
uses Pi's JavaScript runtime and requires no separate Rust host build.

Subagents and its shared UI/settings packages remain pinned npm dependencies.
The tracked Subagents patch loads Pi's built-in tools in child sessions and
preserves the parent's active-tool selection. The upstream Subagents tarball
still bundles unused legacy Code Mode sources; the adapter no longer imports
or builds them. The XSettings patch preserves Pi settings that are not overridden
in TOML and restores missing configured tools on startup, reload, and tree
navigation. Configured defaults are a baseline, not a record of temporary tool
toggles; CLI restrictions and persisted token-burden disables still apply.
The LibTUI patch bounds animation ticks when rendering remounts targets.
It also supplies transcript timestamps and semantic activity labels for folding.
These reliability fixes are backported from `luan/agents` at `ad0bff62` without
upgrading the UI packages. Composition tests exercise native tool calls and
session isolation.

The presentation adapters use guarded Pi UI internals and restore native behavior
on unload. They do not rewrite session history or model-visible output. Remove
`extensions/collapse-transcript/index.ts` from the extension list to disable transcript
folding independently of compact Code Mode framing.

Async questions are a question-only adaptation of the same upstream revision,
using the existing UI dependencies. They do not add clock tools, persistent
reasoning, or a new provider. Required answers must arrive before dependent
work proceeds. The tool is model-only (not callable inside Code Mode); ordinary
independent work can continue while a question is pending. RPC clients use
standard select/input dialogs; headless sessions retain pending questions until
a user-capable client resumes them.

Our `fileops/` continues to own read, search, find, write, and hashline editing.
Our `apply-patch/` owns structured patches, validates them before writing, shares
file mutation queues, and reports completed paths after partial filesystem
failures. Upstream's current `pi-fileops` is patch-only and is not installed over
either extension. Mutation queues coordinate operations within one Pi process;
they do not lock out other editors or terminal processes.

Core file, shell, and skill tools run under `codemode`; their JavaScript results
contain `content` and `details`. Nested calls retain argument validation, shell
output limits, error reporting, Context Guard wrapping, and disabled-tool checks.
`tool_search` stays direct and loads deferred Context Guard and terminal-lane
tools on demand. Native `searchTools()` and `describeTool()` discover callable
tools omitted from the inline description. Subagent settings remain in `/xsettings`.

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
The `skill` tool rejects skills with `disable-model-invocation: true`; explicit
user commands and mentions still work. Shared instructions require an explicit
user request for formal review skills and delegated review workflows, even when
repository guidance calls them mandatory. Routine self-review and relevant
checks remain automatic. This is not a filesystem access restriction.

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

## Behavioral prompt evaluations

These opt-in model runs exercise the current base prompt, global instructions,
and skill bodies against a small in-memory workspace. They complement, rather
than replace, the prompt-rendering and schema tests.

```sh
bun run eval:prompts --list
bun run eval:prompts --model <provider>/<model>
bun run eval:prompts --model <provider>/<model> --case diagnose-and-fix
```

An explicit model is required. The runner uses pi's configured credentials and
model catalog; live calls incur provider usage. It does not load extensions or
extension-provided models. Ordinary `bun test` runs only offline runner/grader
tests and makes no model requests.

Cases check observable tool calls and state:

- Diagnosis alone reproduces the failure without editing.
- Diagnosis plus an authorized fix changes the source and verifies afterward,
  without asking for redundant approval.
- A context skill loads its referenced rules through resolvable paths.
- An ambiguous commit asks how to split unrelated changes and preserves the index.
- An unavailable search tool is not invented; available reads suffice.

Model-controlled tools operate only on allowlisted instruction copies and virtual
workspace files. No command or generated code executes on the host, and there is
no real Git index or filesystem mutation. The simulated shell supports only the
commands named in its tool description. The synthetic test recognizes the fixture's
simple addition correction; it is not a general TypeScript test runner.

Runs are sequential and bounded to eight turns, twenty tool calls per turn,
2048 output tokens per turn, and ninety seconds per case. Output goes to stdout:
a prompt/fixture fingerprint, pass/fail/error status, failed checks, bounded tool
results, final response, and provider-reported token/cost estimates. An incomplete
or provider-failed run is an error, not a behavioral failure or passing result.
Any non-passing case produces a nonzero exit status. Nothing is saved by default.

These are controlled direct-tool contract probes, not end-to-end tests of Code
Mode, real shell/Git behavior, full extension composition, or prose accuracy.
A single passing run does not establish reliability; repeat relevant cases on
the same model when comparing instruction changes and inspect failed traces
before attributing a failure to the prompt rather than the simulator.
