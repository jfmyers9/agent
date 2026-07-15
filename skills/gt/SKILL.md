---
name: gt
description: >
  Run a supported Graphite stack command when the user explicitly asks to
  create a clean branch, inspect, restack, perform a guarded sync, amend, or
  navigate a Graphite branch stack. Trigger: /gt.
allowed-tools: Bash
argument-hint: >
  [create|log|restack|sync|info|amend|up|down|top|bottom] [arguments]
---

# Gt

Run a bounded set of Graphite branch and stack operations.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `<command>` — one of `create`, `log`, `restack`, `sync`, `info`, `amend`,
  `up`, `down`, `top`, or `bottom`
- `[arguments]` — arguments supported by the bounded workflow below

| Command | Action |
| --- | --- |
| `create` | Create a clean, empty branch on the current branch |
| `log` | Show tracked stacks |
| `restack` | Rebase branches onto their Graphite parents |
| `sync` | Guarded repository-wide remote sync |
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
3. For `create`, accept exactly one branch name and no flags. Do not add a user,
   team, or other namespace prefix. Validate it with
   `git check-ref-format --branch` and reject an existing local branch. Require
   `git status --short` to be empty because `gt create` can commit staged work
   and prompt to stage unstaged work. Run
   `gt create <quoted-branch-name> --no-interactive`, confirm the current branch
   with `git branch --show-current`, report it, and stop. Do not fall back to
   `git switch -c`. If creation fails, report the Graphite error without
   retrying with different branch semantics.
4. For `sync`, accept only `--restack`, `--no-restack`, `--all`, and `--debug`;
   reject positional arguments and every other flag. In particular, reject
   `--force`/`-f`, `--delete-all`/`-d`, `--no-interactive`, `--quiet`/`-q`,
   `--cwd`, and `--no-verify`, including long `--flag=value` forms and short
   flag clusters. Require a clean worktree. Inspect the installed command's
   `gt sync --help` before warning about its documented destructive behavior.
   For Graphite 1.8.6, state that sync may delete local branches whose PRs are
   merged or closed and may overwrite local trunk when it cannot fast-forward
   to the remote. Require a second explicit user confirmation after this
   warning; the original invocation is not confirmation. Keep the command
   interactive so Graphite can prompt before branch deletion. If confirmation
   is absent, stop without running `gt sync`. When `--all` is present, include
   every configured trunk in the warned scope. After confirmation, run
   `gt sync <parsed-arguments>` once without adding flags.
5. Apply command-specific local safeguards:
   - For `restack`, require a clean worktree and index before rewriting branch
     ancestry.
   - For `up`, `down`, `top`, or `bottom`, inspect `git status --short` and stop
     rather than carrying dirty work across branches.
   - For `amend`, inspect staged and unstaged diffs first. Never infer a staging
     choice or include unrelated changes; stop when the requested amend scope
     is unclear.
6. Run other commands as `gt <command> <parsed-arguments>`, except map the
   public `amend` command to `gt modify` for current Graphite versions. Pass
   parsed arguments as shell-quoted values; never execute raw `$ARGUMENTS`.
7. For commands other than `sync`, use noninteractive mode when no user choice
   is required. If Graphite needs a branch selection or staging decision,
   surface the choices instead of guessing or leaving an unattended prompt.
   Never infer or add destructive flags.
8. Report the resulting branch or stack state. If a restack, sync, or amend
   stops on conflicts, preserve the conflict state and report Graphite's
   `continue`/`abort` guidance; do not choose a resolution automatically.
