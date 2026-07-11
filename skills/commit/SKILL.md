---
name: commit
description: >
  Create a Conventional Commit when the user explicitly asks to commit changes.
  Generate the message when omitted; optionally push after committing.
  Triggers: /commit, "commit this".
allowed-tools: Bash
argument-hint: >
  [--amend] [--fixup <commit>] [--push] [--as <identity>]
  [--author <identity>] [--committer <identity>] [message]
---

# Commit

Create one accurate Conventional Commit from the intended changes.

@rules/pr-workflow.md and @rules/harness-compat.md apply.

## Arguments

- `[message]` — complete commit message; generate it when omitted
- `--amend` — replace the current commit with the staged result
- `--fixup <commit>` — create a fixup commit targeting `<commit>`
- `--push` — push after committing
- `--as <identity>` — set both author and committer
- `--author <identity>` — set only the author
- `--committer <identity>` — set only the committer

Accept identities as `Name <email@example.com>` or an email address. For an
email-only value, use `git config user.name`; if it is unset, derive a readable
name from the email local-part. Quote every user-derived shell argument.

## Guardrails

- Act without prompting when one coherent, non-sensitive change set is clear.
- Never stage untracked files automatically.
- Stop for confirmation when staged or candidate files appear to contain
  credentials, secrets, `.env` data, or private keys.
- Ask how to split clearly unrelated changes instead of combining them.
- Never pull, rebase, force-push, or retry with a force option as part of this
  skill.
- If `--amend` and `--push` are combined, explain that the remote update may
  require a history rewrite and stop before committing.

## Message Policy

Use this Conventional Commit form:

```text
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

Choose the type from observable intent: `feat`, `fix`, `docs`, `test`,
`refactor`, `perf`, `build`, `ci`, or `chore`. Add a concise subsystem scope
only when it improves scanning.

For a generated message, a subject alone is sufficient only for a trivial,
self-explanatory diff such as a typo, formatting-only edit, obvious version
bump, or tiny mechanical change. For every meaningful diff, generate a short
body that leads with why the change was made or its observable outcome. Include
implementation detail only when it helps future maintenance; do not narrate
file names or repeat the subject. Wrap body lines at 72 characters.

Use `!` and a `BREAKING CHANGE: <description>` footer for breaking API, config,
data, workflow, or compatibility changes. Preserve relevant trailers such as
`Fixes: #123`, `Refs: #123`, and `Co-authored-by: Name <email>`.

## Workflow

1. **Parse and validate arguments**
   - Extract recognized flags, their values, and the remaining message.
   - Treat a trailing `as <identity>` as `--as <identity>` only when no explicit
     identity flag is present and the suffix already matches an accepted email
     or `Name <email>` form. Otherwise keep it in the commit message.
   - Require a target for `--fixup`; reject unknown flags and the incompatible
     `--amend --fixup` combination.
   - Reject a freeform message with `--fixup`; Git must derive that subject from
     the target commit.
   - Apply `--as` to both identities, then let `--author` or `--committer`
     override its respective side.
   - Reject malformed identities or identities without a valid email address.

2. **Inspect the repository and intended diff**
   - Run `git status --short` (never `-uall`), `git diff --cached --stat`, and
     `git diff --cached --name-status`.
   - Inspect the meaningful staged hunks with
     `git diff --cached --no-ext-diff`; target relevant paths when the diff is
     large instead of dumping or truncating it.
   - For `--amend`, also inspect the current message and commit with
     `git log -1 --format='%B'` and `git show --stat --format=fuller HEAD`.
     Evaluate the amended commit as the existing commit plus staged changes.

3. **Prepare the index**
   - Treat `--amend` with an empty index plus a supplied message or identity as
     a tree-preserving amend. Do not stage tracked or untracked working-tree
     changes unless the user explicitly asks to include them. If the index is
     not empty, ask whether those changes belong before continuing. For a
     confirmed tree-preserving amend, skip the remaining index-preparation
     bullets.
   - If the index is empty and tracked files changed, stage tracked changes with
     `git add -u`, subject to the sensitive/unrelated-change guardrails and the
     tree-preserving exception above.
   - If only untracked files changed, list them and ask which should be added.
   - When tracked and untracked changes coexist, leave untracked files unstaged
     and report them. Ask before continuing if they are required for a coherent
     commit.
   - Allow an empty index for `--amend` only when the user supplied a new
     message or identity. Otherwise report that there is nothing to commit.
   - A fixup commit always requires staged changes.
   - Refresh the staged stat, names, and meaningful hunks after staging.

4. **Choose and validate the message**
   - For `--fixup`, let Git derive the `fixup!` message.
   - For a tree-preserving amend without a supplied message, preserve the
     existing message exactly. Validate a supplied replacement normally.
   - Accept a supplied message when its subject is valid and it accurately
     describes the staged result. Ask for correction or permission to generate
     a replacement only when it is invalid, misleading, or omits an evident
     breaking, migration, security, or compatibility risk.
   - Otherwise generate the smallest message that remains useful without this
     chat context. Use imperative mood, no trailing period, and the body/footer
     rules above.
   - Before committing, verify type, scope, subject, body decision, trailers,
     and breaking-change notation against the staged result.

5. **Commit safely**
   - Use `git commit --fixup <commit>` for a fixup.
   - Use `git commit --amend --no-edit` for a tree-preserving amend without a
     supplied message.
   - For normal and replacement messages, pass the complete message through
     `git commit -F -` or `git commit --amend -F -` with a quoted heredoc whose
     delimiter does not occur in the message. Do not interpolate message text
     into a shell command.
   - Apply a normalized author with `--author='Name <email>'`. Apply a
     normalized committer with `GIT_COMMITTER_NAME` and
     `GIT_COMMITTER_EMAIL`, shell-quoted safely, on the same command.
   - If the commit fails, report the error and leave the index intact.

6. **Report and optionally push**
   - Show `git log -1 --oneline`. When identity was overridden, show
     `git log -1 --format='%h %an <%ae> committed-by %cn <%ce> %s'`.
   - For `--push`, run `git push` when an upstream exists, or
     `git push --set-upstream origin HEAD` when it does not and `origin` exists.
     On failure, report the error without pulling, rebasing, or forcing.
