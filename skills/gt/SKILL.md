---
name: gt
description: >
  Run a supported Graphite stack command when the user explicitly asks to
  inspect, restack, sync, amend, or navigate a Graphite branch stack.
  Trigger: /gt.
allowed-tools: Bash
argument-hint: "[log|restack|sync|info|amend|up|down|top|bottom] [flags]"
---

# Gt

Run a bounded set of Graphite branch and stack operations.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `<command>` — one of `log`, `restack`, `sync`, `info`, `amend`, `up`,
  `down`, `top`, or `bottom`
- `[flags]` — flags and values supported by that Graphite command

| Command | Action |
| --- | --- |
| `log` | Show tracked stacks |
| `restack` | Rebase branches onto their Graphite parents |
| `sync` | Sync Graphite branches with their remotes |
| `info` | Show current or named branch information |
| `amend` | Amend the current branch commit and restack descendants |
| `up`, `down` | Move through the current stack |
| `top`, `bottom` | Move to a stack endpoint |

## Workflow

1. Parse the first token as the command and the rest as its arguments. If no
   command is supplied, show the table above and stop. Reject unsupported
   commands rather than passing them to `gt`.
2. Verify that `gt` is available and that the path from
   `git rev-parse --git-path .graphite_repo_config` exists. Do not invoke `gt`
   merely as a detector because current versions may initialize the repository.
   Report either failure without attempting a Git fallback.
3. Run `gt <command> <parsed-arguments>`, except map the public `amend` command
   to `gt modify` for current Graphite versions. Pass parsed arguments as
   shell-quoted values; never execute raw `$ARGUMENTS`.
4. Use noninteractive mode when no user choice is required. If Graphite needs a
   branch selection or staging decision, surface the choices instead of
   guessing or leaving an unattended prompt.
5. Do not infer or add destructive flags such as `--force` or `--delete-all`.
   Run them only when the user supplied them explicitly.
6. Report the resulting branch or stack state. If a restack, sync, or amend
   stops on conflicts, preserve the conflict state and report Graphite's
   `continue`/`abort` guidance; do not choose a resolution automatically.
