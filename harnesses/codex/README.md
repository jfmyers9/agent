# Codex Adapter

Codex-specific settings for this workflow config.

Installed to `~/.codex/` and `~/.agents/` by:

```sh
./install.sh codex
```

Codex loads:

- `~/.codex/config.toml` for model, approvals, sandbox, hooks, and TUI defaults
- `~/.codex/hooks.json` plus linked scripts in `~/.codex/hooks/` for lightweight workflow hooks
- plugins declared in `harnesses/codex/packages.json`, installed through the Codex CLI
- `AGENTS.md` from each repository as project instructions
- `$HOME/.agents/skills` for user-level Agent Skills
- `bin/blueprint` as a shared CLI

The installer copies the mutable baseline config and links shared files:

- `harnesses/codex/config.toml` to `~/.codex/config.toml` as a baseline copy
- `harnesses/codex/hooks.json` to `~/.codex/hooks.json`
- `harnesses/codex/hooks/*` to `~/.codex/hooks/`
- `global/AGENTS.md` to `~/.codex/AGENTS.md` as a reference copy
- `rules/` to `~/.codex/rules-md` as reference Markdown
- `skills/` to `~/.agents/skills` for Codex discovery
- `rules/` to `~/.agents/rules` for shared skill references

The installer idempotently adds the Ponytail marketplace and plugin. Ponytail's
hooks still require review and trust through `/hooks` after first installation.
Set `CODEX_SKIP_PACKAGES=1` for an offline install that skips external plugins.

Caveman `lite` is always enabled by `global/AGENTS.md`. The standalone Caveman
skill installer is intentionally not run because this repository owns
`~/.agents/skills` as a link to its tracked shared skills.

If `~/.codex/config.toml` already exists as a real file, the installer preserves
it. Codex may append local runtime state such as project trust, hook trust
hashes, and UI notices to the installed copy; those tables are intentionally
not checked into this repo.

Adopted Luan-inspired Codex ergonomics:

- high plan-mode reasoning
- `alt-enter` composer queueing
- status line fields for run state, model/reasoning, cwd, branch, and context
- Codex hooks enabled with local, dependency-light hooks only

Rejected Luan defaults remain rejected here: no `approval_policy = "never"`, no
`danger-full-access`, no `ct`/mux hooks, and no user-specific paths or env vars.
The full adopted/deferred/rejected ledger is in
[`../../docs/luan-feature-decisions.md`](../../docs/luan-feature-decisions.md).

Codex discovers skills by name with `$<skill-name>` mentions or by
matching the skill description. Use `/skills` in the Codex CLI to inspect
available skills.

For repository-local use, keep `AGENTS.md` in the repo root. Codex reads it
automatically when launched inside that repository.
