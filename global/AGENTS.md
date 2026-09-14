# Global Instructions

## Workflow

- Use conventional commits for commit messages

## Conciseness

- Make plans extremely concise. Sacrifice grammar for concision.
- Prefer bullet points over prose. Omit filler words.
- In conversation, be direct. Skip preamble and summaries unless
  asked.

## Efficiency

- Run parallel independent operations when the harness supports it
- Delegate heavy work to worker/subagents when available; main
  thread orchestrates
- Pre-compute summaries for handoffs rather than passing raw content

## Context Budget

- Pipe long command output through `tail`/`head` to limit volume
- Summarize large file contents rather than reading in full when
  a summary suffices

## Durable Artifacts

Save persistent artifacts only when explicitly requested or through
`$artifact`. Use a requested destination; otherwise use blueprint storage.
Ordinary Q&A, coding, debugging, reviews, and PR work use chat and the working
tree. Existing artifacts are optional inputs, never approval or workflow
state. Reading one does not authorize changing it. Saving does not include
committing or pushing.

@rules/blueprints.md
@rules/context-budget.md
@rules/harness-compat.md
