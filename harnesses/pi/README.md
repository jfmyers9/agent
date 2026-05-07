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
- `bin/blueprint` as a shared CLI

Adopted Pi settings from Luan's config:

- quiet startup and reduced terminal progress noise
- explicit Codex GPT model cycle (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`)
- tree navigation on double Escape
- Emacs-style movement and queueing shortcuts
- lightweight footer/status icon preferences
- Pi-native usage HUD for context, tokens, cost, model/thinking, cwd, branch, and opt-in OpenAI/Codex quota bars

Feature decisions from the Luan config review are tracked in
[`../../docs/luan-feature-decisions.md`](../../docs/luan-feature-decisions.md).

Installed extensions:

- `mac-system-theme.ts` — syncs Pi's `dark`/`light` theme with macOS appearance.
- `agents-local.ts` — injects untracked `AGENTS.local.md` / `CLAUDE.local.md` context from cwd ancestors; `/agents-local` lists loaded files.
- `clear.ts` — `/clear` starts a fresh session after the current turn; `ctrl+shift+l` queues it.
- `effort.ts` — `/effort [level]` persists per-model thinking effort to `effort.json`.
- `pi-vim/` — replaces the editor with Vim-style modal editing. Remove or move this directory, then reinstall/reload Pi, to disable it.
- `skill-dollar/` — supports `$skill-name` references with autocomplete/highlighting while keeping `/skill:<name>` commands.
- `usage-hud/` — replaces Pi's footer with a local, dependency-light context/token/cost HUD plus opt-in OpenAI/Codex quota bars. Remove or move this directory, then reinstall/reload Pi, to restore Pi's default footer.
- `tasks/` — blueprint-linked project task tools, HUD, and `/tasks` board for fine-grained LLM work chunks.

The usage HUD polls OpenAI/Codex quota only when `tui.json` sets `usageHud.quota.enabled: true`. It reads `~/.pi/agent/auth.json` or `~/.codex/auth.json` and calls ChatGPT's `backend-api/wham/usage` endpoint for 5h/week windows.

Skills are available as `/skill:<name>` and `$skill-name` references by default.

Long-running workflows use blueprints as the durable tracker and project tasks as the fine-grained execution queue:

- `/skill:research` writes `spec/` blueprints
- `/skill:implement` consumes `spec/`, `plan/`, or `review/` blueprints
- `/skill:review` writes `review/` blueprints
- `/skill:fix` writes `plan/` blueprints
- `/skill:vibe` tracks pipeline state in a `plan/` blueprint
- `/tasks blueprint [slug]` imports blueprint steps into project tasks
- `/tasks` opens the Pi task board
