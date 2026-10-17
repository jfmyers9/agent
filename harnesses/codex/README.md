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

If `~/.codex/config.toml` already exists as a real file, the installer preserves
it. Codex may append local runtime state such as project trust, hook trust
hashes, and UI notices to the installed copy; those tables are intentionally
not checked into this repo.

## Linear

The baseline config includes `https://mcp.linear.app/mcp`. On a new machine,
install this adapter, then authorize Linear and inspect the registration:

```sh
codex mcp login linear
codex mcp list
```

If an existing config does not have Linear, add it first:

```sh
codex mcp add linear --url https://mcp.linear.app/mcp
```

Do not re-add an existing customized entry. The installer preserves local
`config.toml` files; it does not merge new baseline entries. OAuth credentials
are managed locally by Codex, never committed. Start a new Codex session after
setup and ask it to list your assigned Linear issues to check tool access.
For Firefox Containers, see the [shared sign-in guidance](../../README.md#linear).

## Ergonomics

Adopted Luan-inspired Codex ergonomics:

- high plan-mode reasoning
- `alt-enter` composer queueing
- status line fields for run state, model/reasoning, cwd, branch, and context
- Codex hooks enabled with local, dependency-light hooks only
- experimental idle-sleep prevention while a turn is running

Rejected Luan defaults remain rejected here: no `approval_policy = "never"`, no
`danger-full-access`, no `ct`/mux hooks, and no user-specific paths or env vars.

Codex discovers skills by name with `$<skill-name>` mentions or by
matching the skill description. Use `/skills` in the Codex CLI to inspect
available skills.

For repository-local use, keep `AGENTS.md` in the repo root. Codex reads it
automatically when launched inside that repository.
