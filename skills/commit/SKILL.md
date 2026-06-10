---
name: commit
description: >
  Create conventional commits with auto-generated messages. Optionally push with --push (non-Graphite repos).
  Use after making changes, when saving progress, done with a change, ready to commit, or finished implementing.
  Triggers: /commit, "commit this".
allowed-tools: Bash
argument-hint: "[--amend] [--fixup <commit>] [--push] [--as <identity>] [--author <identity>] [--committer <identity>] [message]"
---

# Commit

Create conventional commits.

## Arguments

- `[message]` — commit message (generated if omitted)
- `--amend` — amend the previous commit
- `--fixup <commit>` — create fixup commit for specified hash
- `--push` — push after committing (non-Graphite repos only)
- `--as <identity>` — set both author and committer identity
- `--author <identity>` — set author identity only
- `--committer <identity>` — set committer identity only

Identity values may be either `Name <email@example.com>` or an email
address. For email-only values, use `git config user.name` as the name;
if unavailable, derive a readable name from the email local-part. Quote
identities that contain spaces or angle brackets.

## Autonomy

Default to acting without prompting. Only ask for user input when:
- Changed files span clearly unrelated features with no common theme
- Sensitive files (.env, credentials) are in the diff
- There is literally nothing to commit

In all other cases, proceed silently. The user will provide
instructions if they want commits shaped differently.

## Steps

1. **Parse Arguments**
   - Extract `--amend` flag from `$ARGUMENTS`
   - Extract `--fixup <hash>` from `$ARGUMENTS`
   - Extract `--push` flag from `$ARGUMENTS`
   - Extract `--as <identity>`, `--author <identity>`, and
     `--committer <identity>` values from `$ARGUMENTS`
   - Treat a trailing natural-language `as <identity>` phrase as
     `--as <identity>` when no explicit identity flag is present.
   - If `--push` + `--amend`: warn that amending + pushing may require force push, suggest doing it manually. Stop.
   - Extract commit message (remaining text)

2. **Gather Context (Parallel)**
   - `git status` (never use -uall flag)
   - `git diff --cached` (staged changes)
   - If `--amend`: `git log -1 --format="%B"` and `git diff HEAD~1`

3. **Validate Staged Changes**
   - If nothing staged:
     - Check `git diff --name-only` for tracked changes
     - If tracked changes exist: stage all with `git add -u` (tracked only)
     - Only ask user if changed files span clearly unrelated features/modules
     - If nothing at all: report "nothing to commit" and stop

4. **Handle Commit Message**
   - If message provided: validate conventional format `<type>[scope]: <description>`
   - If no message: generate conventional commit message
   - Format multi-line bodies: wrap at 72 characters
   - For `--fixup`: no message validation needed

5. **Handle Identity**
   - If `--as` is provided, apply that identity to both author and
     committer unless `--author` or `--committer` overrides one side.
   - Normalize each requested identity to name and email.
   - Ask only if an identity is malformed or an email-only identity has
     no valid email address.
   - For author identity, pass `--author="Name <email>"` to
     `git commit`; this also works for `--amend`.
   - For committer identity, prefix the commit command with
     `GIT_COMMITTER_NAME="Name" GIT_COMMITTER_EMAIL="email"`.

6. **Execute Commit**
   - Normal: `git commit -m "message"`
   - Amend: `git commit --amend -m "message"`
   - Fixup: `git commit --fixup <hash>`
   - Use HEREDOC for multi-line messages
   - Include any identity env vars and `--author` argument in the same
     commit command.

7. **Show Result**
   - Display final commit with `git log -1 --oneline`
   - If an identity override was used, display:
     `git log -1 --format='%h %an <%ae> committed-by %cn <%ce> %s'`
   - If `--push`:
     - Detect Graphite trunk: `gt trunk 2>/dev/null`
     - If Graphite detected AND current branch is NOT trunk: warn that `--push` bypasses Graphite branch tracking, suggest `/skill:submit` instead, skip push
     - Otherwise: run `git push || (git pull --rebase && git push)`
     - Display push result or error
