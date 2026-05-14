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
- `harnesses/pi/settings.json` for model and TUI defaults
- `harnesses/pi/keybindings.json` for Emacs-style editor/session shortcuts
- `harnesses/pi/tui.json` for status/footer icon and color preferences
- `harnesses/pi/effort.json` for per-model thinking defaults used by `/effort`
- `harnesses/pi/extensions/` as global Pi extensions
- `npm:@dreki-gg/pi-context7@0.1.9` as reviewed docs lookup tools
- `bin/blueprint` as a shared CLI

Adopted Pi settings from Luan's config:

- quiet startup and reduced terminal progress noise
- explicit Codex GPT model cycle (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`)
- tree navigation on double Escape
- Emacs-style movement and queueing shortcuts
- lightweight footer/status icon preferences
- Pi-native usage HUD for context, tokens, cost, model/thinking, cwd, branch, and opt-in OpenAI/Codex quota bars
- local prompt stash/history shortcuts backed by a SQLite database
- Context7 documentation lookup tools via a reviewed, pinned Pi package

Feature decisions from the Luan config review are tracked in
[`../../docs/luan-feature-decisions.md`](../../docs/luan-feature-decisions.md).

Installed extensions:

- `mac-system-theme.ts` — syncs Pi's `dark`/`light` theme with macOS appearance.
- `agents-local.ts` — injects untracked `AGENTS.local.md` / `CLAUDE.local.md` context from cwd ancestors; `/agents-local` lists loaded files.
- `clear.ts` — `/clear` starts a fresh session after the current turn; `ctrl+shift+l` queues it.
- `effort.ts` — `/effort [level]` persists per-model thinking effort to `effort.json`.
- `pi-vim/` — replaces the editor with Vim-style modal editing. Remove or move this directory, then reinstall/reload Pi, to disable it.
- `skill-dollar/` — supports `$skill-name` references with autocomplete/highlighting while keeping `/skill:<name>` commands.
- `prompt-storage/` — local prompt stash/history. Shortcuts: `alt+s` stash current draft, `ctrl+alt+s` pop a stash, `ctrl+r` search previous prompts.
- `usage-hud/` — replaces Pi's footer with a local, dependency-light context/token/cost HUD plus opt-in OpenAI/Codex quota bars. Remove or move this directory, then reinstall/reload Pi, to restore Pi's default footer.
- `tasks/` — blueprint-linked project task tools, HUD, and `/tasks` board for fine-grained LLM work chunks. Blueprints stay project-scoped; task queues default to a worktree lane under the project task root to avoid parallel-worktree collisions.

The usage HUD polls OpenAI/Codex quota only when `tui.json` sets `usageHud.quota.enabled: true`. It reads `~/.pi/agent/auth.json` or `~/.codex/auth.json` and calls ChatGPT's `backend-api/wham/usage` endpoint for 5h/week windows.

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
