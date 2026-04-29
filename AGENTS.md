# Global Instructions

## Workflow

- I use Graphite for branch management
- Use the submit workflow to sync and create PRs
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

## Planning State

Prefer portable, file-backed state over harness-native state:

- Research specs: `blueprint create spec "<topic>"`
- Implementation plans: `blueprint create plan "<topic>"`
- Reviews: `blueprint create review "<topic>"`
- Reports: `blueprint create report "<topic>"`

When a harness provides native tasks, they may mirror blueprint state,
but blueprints remain the portable source of truth.

@rules/blueprints.md
@rules/context-budget.md
@rules/harness-compat.md
