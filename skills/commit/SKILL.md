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

Create Conventional Commits with useful generated messages.

## Arguments

- `[message]` - commit message (generated if omitted)
- `--amend` - amend the previous commit
- `--fixup <commit>` - create fixup commit for specified hash
- `--push` - push after committing (non-Graphite repos only)
- `--as <identity>` - set both author and committer identity
- `--author <identity>` - set author identity only
- `--committer <identity>` - set committer identity only

Identity values may be either `Name <email@example.com>` or an email
address. For email-only values, use `git config user.name` as the name;
if unavailable, derive a readable name from the email local-part. Quote
identities that contain spaces or angle brackets.

## Autonomy

Default to acting without prompting. Only ask for user input when:
- Changed files span clearly unrelated features with no common theme
- Sensitive files (.env, credentials) are in the diff
- There is literally nothing to commit
- A provided commit message is invalid, misleading, or dangerously
  incomplete for an obvious breaking change, migration, security fix, or
  compatibility risk

In all other cases, proceed silently. The user will provide
instructions if they want commits shaped differently.

## Message Quality Policy

Generate the smallest commit message that will still make sense to a
future reader reviewing history without this chat context.

Use this Conventional Commit shape:

```text
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

Subject-only commits are allowed only when the staged diff is trivial and
self-explanatory. Examples:
- typo-only or wording-only documentation edits
- formatting-only changes
- a single obvious version/config bump
- tiny mechanical updates where the subject fully explains the change

For all non-trivial changes, generate a body by default. Include a body
when the diff is behavior-changing, user-facing, architectural,
cross-module, risky, test-only but semantically meaningful, a bug fix
whose cause matters, or not obvious from the subject alone.

Body rules:
- Explain the "why" or observable outcome first.
- Add key implementation detail only when it helps future maintenance.
- Do not restate a file list or narrate obvious edits.
- Prefer one short paragraph; use bullets only when they improve clarity.
- Wrap body lines at 72 characters.

Footer rules:
- Use `BREAKING CHANGE: <description>` for breaking API, config, data,
  workflow, or compatibility changes. The header may also use `!`.
- Use valid Git trailer-style footers when applicable, such as
  `Fixes: #123`, `Refs: #123`, or `Co-authored-by: Name <email>`.
- Put footers after one blank line following the body. If there is no
  body, put footers after one blank line following the subject.

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
   - `git status --short` (never use `-uall`)
   - `git diff --cached --stat`
   - `git diff --cached --name-status`
   - `git diff --cached --no-ext-diff` for the meaningful staged hunks
   - If `--amend`: `git log -1 --format="%B"` and `git diff HEAD~1`

3. **Validate Staged Changes**
   - If nothing staged:
     - Check `git diff --name-only` for tracked changes
     - If tracked changes exist: stage all with `git add -u` (tracked only)
     - Refresh staged context with `git diff --cached --stat`,
       `git diff --cached --name-status`, and meaningful staged hunks
     - Only ask user if changed files span clearly unrelated features/modules
     - If nothing at all: report "nothing to commit" and stop

4. **Analyze Diff For Message Content**
   - Choose the Conventional Commit type from the staged behavior:
     - `feat`: user-visible feature or capability
     - `fix`: bug fix
     - `docs`: documentation-only change
     - `test`: test-only change
     - `refactor`: behavior-preserving code restructuring
     - `perf`: performance improvement
     - `build`, `ci`, `chore`, or similar for tooling/maintenance
   - Choose a concise scope from the main subsystem when it improves
     scanning. Omit scope when no single useful scope exists.
   - Decide whether a body is required using the Message Quality Policy.
     If omitting the body, be able to justify that the diff is trivial or
     fully explained by the subject.
   - Identify required footers: breaking changes, issue references,
     co-authors, or other trailers already implied by the work.

5. **Handle Commit Message**
   - For `--fixup`: no message validation needed.
   - If message provided:
     - Validate Conventional Commit format:
       `<type>[optional scope][optional !]: <description>`
     - Accept a valid concise message unless it misstates the diff or
       omits known breaking-change, migration, security, or compatibility
       context.
     - If invalid or dangerously incomplete, ask for a corrected message
       or permission to generate one.
   - If no message: generate a Conventional Commit message from the diff
     analysis.
   - Generated subject rules:
     - Use imperative mood.
     - Keep it concise and specific.
     - Avoid a trailing period.
     - Include `!` only for breaking changes.
   - Generated body/footer rules:
     - Include a body for non-trivial diffs.
     - Wrap body lines at 72 characters.
     - Include required footers using valid trailer syntax.
   - Before committing, self-check:
     - Type and scope match the staged diff.
     - Subject is accurate without being vague.
     - Body is present for meaningful diffs or intentionally omitted for
       a trivial/self-explanatory diff.
     - Body explains why/outcome and avoids redundant file narration.
     - Footer syntax is valid and breaking changes are marked.

6. **Handle Identity**
   - If `--as` is provided, apply that identity to both author and
     committer unless `--author` or `--committer` overrides one side.
   - Normalize each requested identity to name and email.
   - Ask only if an identity is malformed or an email-only identity has
     no valid email address.
   - For author identity, pass `--author="Name <email>"` to
     `git commit`; this also works for `--amend`.
   - For committer identity, prefix the commit command with
     `GIT_COMMITTER_NAME="Name" GIT_COMMITTER_EMAIL="email"`.

7. **Execute Commit**
   - Fixup: `git commit --fixup <hash>`
   - Subject-only normal commit: `git commit -m "<subject>"`
   - Subject-only amend: `git commit --amend -m "<subject>"`
   - Multi-line normal commit: use a heredoc or equivalent
     multi-line-safe command:

     ```sh
     git commit -F - <<'COMMIT_MSG'
     <type>(<scope>): <subject>

     <body wrapped at 72 characters>

     <footer-token>: <footer value>
     COMMIT_MSG
     ```

   - Multi-line amend: use `git commit --amend -F -` with the same
     heredoc pattern.
   - Include any identity env vars and `--author` argument in the same
     `git commit` command, including heredoc-based commands.

8. **Show Result**
   - Display final commit with `git log -1 --oneline`
   - If an identity override was used, display:
     `git log -1 --format='%h %an <%ae> committed-by %cn <%ce> %s'`
   - If `--push`:
     - Detect Graphite trunk: `gt trunk 2>/dev/null`
     - If Graphite detected AND current branch is NOT trunk: warn that `--push` bypasses Graphite branch tracking, suggest `/skill:submit` instead, skip push
     - Otherwise: run `git push || (git pull --rebase && git push)`
     - Display push result or error
