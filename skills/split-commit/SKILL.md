---
name: split-commit
description: >
  Rewrite a multi-commit topic branch into clean, tested, vertical Conventional
  Commits when the user explicitly asks to reorganize branch history.
argument-hint: "[base-branch] [--test='<command>'] [--auto] [blueprint-slug-or-path]"
user-invocable: true
allowed-tools: [Bash, Read, Glob, Grep]
---

# Split Commit

Repackage local branch history without creating a tracker or changing remotes.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `[base-branch]` — comparison base; default to the Graphite parent, then the
  remote default or `main` outside a Graphite stack
- `--test='<command>'` — verification command to run for each rebuilt commit
- `--auto` — approve the proposed split without a separate confirmation turn
- `[blueprint-slug-or-path]` — optional, explicitly named intent context

## Workflow

1. **Validate the rewrite boundary**
   - Parse supported arguments and reject unknown flags.
   - Resolve the default base with `gt parent` when Graphite metadata exists;
     do not default a stacked branch to trunk. Require a clean index and
     worktree, a non-trunk current branch, and a base that is an ancestor of
     `HEAD`. Never rewrite merge commits implicitly.
   - On a Graphite-tracked branch, require the base to equal its immediate
     Graphite parent. Reject a lower base that would absorb or rewrite
     downstack branches; split those branches separately.
   - Record Graphite children. If any exist, include the required descendant
     restack and its history impact in the approval; never strand descendants
     on the original tip.
   - Count `<base>..HEAD`. For zero or one commit, stop and suggest `$commit`.
   - Record the original tip hash and whether the branch has a remote or open
     PR so the plan states the recovery point and remote-history impact.

2. **Analyze the complete branch change**
   - Inspect a bounded log, name/status summary, meaningful diff hunks, build
     metadata, and dependencies between changed code.
   - Read a blueprint only when the user named it; treat it as optional intent,
     never as permission to ignore the live diff.
   - Use the supplied test command or select relevant existing checks from
     repository configuration. Do not invent a command the project does not
     define.

3. **Propose the vertical commits**
   - Give each commit a Conventional Commit message, exact files or hunks,
     dependencies, and verification command.
   - Put foundations before consumers; keep config and lockfiles with their
     consumer; introduce types with their first use. Each commit should build
     and test independently when practical.
   - Preserve the final tree exactly. Do not add cleanup changes that were not
     present in the original branch.
   - Show the original tip, base, planned commits, tests, and whether updating
     an existing remote branch will later rewrite its history.

4. **Obtain approval**
   - Unless `--auto` was explicitly supplied, show the proposal and wait for
     approval before running any history-rewriting command.
   - Treat requested plan changes as a revised proposal; do not begin the
     rewrite until the revision is approved.

5. **Rebuild the commits**
   - After approval, read `skills/git-surgeon/SKILL.md` before partial staging.
   - Reset the branch to the base with the original tree preserved as unstaged
     changes. Never use `--hard`.
   - For each approved group, stage only its named files or fresh hunk patches,
     inspect the cached diff, and commit with the approved message. Never use
     `git add .` as a shortcut.
   - Verify that exact commit in a detached temporary worktree, then remove the
     temporary worktree. Do not test it in the primary worktree: unstaged later
     groups would contaminate the result.
   - If isolated verification reveals a dependency error, correct the grouping
     and rerun the check against the rebuilt commit. Ask again before any
     material departure from the approved split.
   - On failure, stop with the current worktree intact and report the original
     tip plus an exact recovery command; do not reset or discard work.
   - When Graphite children were recorded, run
     `gt restack --upstack --no-interactive` after rebuilding. Stop on conflicts
     with Graphite's continue/abort guidance and do not submit.

6. **Verify the result**
   - Require an empty `git status --short` and no tree difference between the
     rebuilt `HEAD` and the recorded original tip.
   - When descendants were restacked, verify their stack shape and report their
     rewritten local tips.
   - Show `<base>..HEAD`, report every test result, and identify any skipped
     check. Do not push, force-push, submit, or update a blueprint.

Do not create or update a blueprint. Never rewrite history before approval
unless `--auto` was explicitly supplied.
