# Claude Code Adapter

Claude-specific files for this workflow config.

Installed to `~/.claude/` by:

```sh
./install.sh claude
```

Includes:

- `settings.json` — Claude Code settings, hooks, plugins, model
- `statusline.py` — Claude Code statusline protocol
- `hooks/notify-completion.sh` — Claude notification hook

Shared instructions come from `global/AGENTS.md`. The installer links it as
`~/.claude/AGENTS.md` and links `global/CLAUDE.md` as
`~/.claude/CLAUDE.md`. Root `AGENTS.md` remains repository-only.
