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
- `bin/blueprint` as a shared CLI

Skills are available as `/skill:<name>` by default. Add Pi extensions
later if direct aliases like `/commit` or `/submit` are desired.
