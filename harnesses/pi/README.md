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
- `harnesses/pi/extensions/` as global Pi extensions
- `bin/blueprint` as a shared CLI

Installed extensions:

- `mac-system-theme.ts` — syncs Pi's `dark`/`light` theme with macOS appearance.

Skills are available as `/skill:<name>` by default. Add more Pi extensions
later if direct aliases like `/commit` or `/submit` are desired.

Long-running workflows use blueprints as the Pi work tracker:

- `/skill:research` writes `spec/` blueprints
- `/skill:implement` consumes `spec/`, `plan/`, or `review/` blueprints
- `/skill:review` writes `review/` blueprints
- `/skill:fix` writes `plan/` blueprints
- `/skill:vibe` tracks pipeline state in a `plan/` blueprint
