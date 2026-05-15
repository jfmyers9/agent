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
- `harnesses/pi/effort.json` for per-model thinking defaults used by `/effort`
- `harnesses/pi/extensions/` as global Pi extension sources
- `npm:pi-lens` for AST/LSP/code-intelligence checks
- `npm:@dreki-gg/pi-context7@0.1.9` as reviewed docs lookup tools
- `bin/blueprint` as a shared CLI

Adopted Pi settings from Luan's config:

- quiet startup and reduced terminal progress noise
- explicit Codex GPT model cycle (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`)
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

- `plannotator-events/` — guards Plannotator request listeners across reloads.
- `agents-local/` — injects untracked `AGENTS.local.md` / `CLAUDE.local.md` context from cwd ancestors; `/agents-local` lists loaded files.
- `clear.ts` — `/clear` starts a fresh session after the current turn; `ctrl+shift+l` queues it.
- `effort.ts` — `/effort [level]` persists per-model thinking effort to `effort.json`.
- `mac-system-theme.ts` — syncs Pi's `dark`/`light` theme with macOS appearance.
- `prompt-storage/` — local prompt stash/history. Shortcuts: `alt+s` stash current draft, `ctrl+alt+s` pop a stash, `ctrl+r` search previous prompts.
- `vim/` — replaces the editor with Vim-style modal editing. Remove it from `settings.json`'s `extensions` list, then reinstall/reload Pi, to disable it.
- `tasks/` — blueprint-linked project task tools, HUD, and `/tasks` board for fine-grained LLM work chunks. Blueprints stay project-scoped; task queues default to a worktree lane under the project task root to avoid parallel-worktree collisions.
- `skillful/` — supports `$skill-name` references with autocomplete/highlighting/caching and registers a `skill` tool while keeping `/skill:<name>` commands available.
- `system-prompt/` — renders a tested Mustache system prompt from active tools, context files, skills, cwd, date, and timezone.
- `token-burden/` — reports prompt/session token categories, tool burden, and skill burden.
- `tui/` — owns Pi footer/editor chrome for cwd, git, model/thinking, context, tokens, and cost. `/usage-bars [on|off|toggle]` exists, but `tui.json` defaults usage bars off because Luan's bar renderer can call `ct`.
- `spawn/` — provides `/spawn`, `spawn_lane`, `spawn_list`, and `spawn_map` for bounded Pi/shell/command lanes. Prefer project tasks for durable execution queues and spawn lanes for parallel or isolated context slices.
- `git-tool/` — repo-configured Git workflow prompt guidance and skill resources. Set with `git config agents.git-tool graphite`, `git-spice`, `main`, or `none`.

Retired local extension names:

- `skill-dollar/` is replaced by `skillful/`.
- `pi-vim/` is replaced by `vim/`.
- `usage-hud/` is replaced by `tui/` as the sole footer owner.

Prompt storage is local-only and stores stashes/history in `${XDG_STATE_HOME:-~/.local/state}/pi/prompt-storage.sqlite`. Slash commands are excluded from history by default. Delete that SQLite file to clear prompt-storage data.

Context7 is installed as a pinned reviewed Pi package. It registers `context7_resolve_library_id`, `context7_get_library_docs`, and `context7_get_cached_doc_raw`. API key is optional; set `CONTEXT7_API_KEY` for higher limits. Its cache lives under `~/.pi/agent/extensions/context7/cache/`. Pi packages execute extension code with full local privileges, so bump package versions only after review.

Skills are available as `/skill:<name>` and `$skill-name` references by default.

Long-running workflows use blueprints as the durable tracker and project tasks as the fine-grained execution queue:

- `/skill:research` writes `spec/` blueprints
- `/skill:implement` consumes `spec/`, `plan/`, or `review/` blueprints
- `/skill:review` writes `review/` blueprints
- `/skill:fix` writes `plan/` blueprints
- `/skill:vibe` tracks pipeline state in a `plan/` blueprint
- `/tasks blueprint [slug]` imports blueprint steps into the current worktree task lane
- `/tasks` opens the current worktree task board
- `/tasks all` opens an aggregate board across worktree lanes, with lane labels
- `task_list`/HUD/guard default to the current worktree lane; use `scope: "all_worktrees"` for explicit aggregate inspection

Task lane smoke check: in two git worktrees for the same project, run `/tasks blueprint <slug>` in each, then confirm `/tasks` only shows that worktree's queue while `/tasks all` shows both lane labels.

Validation:

```sh
bun install
bun run typecheck
bun run test:pi-low-risk
bun run test:pi-skillful
bun run test:pi-system
bun run test:pi-tui
bun run test:pi-token
bun run test:pi-spawn
PI_CONFIG_DIR=$(mktemp -d) ./install.sh pi
```
