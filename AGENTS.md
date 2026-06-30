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

## Durable Artifacts

Blueprints are opt-in. Create them only when I explicitly invoke `context`,
`research`, `review`, `diagnose`, `acceptance`, `simplify`, `report`, or
`archive`.

- Proposals: `blueprint create proposal "<topic>"`
- Reviews: `blueprint create review "<topic>"`
- Reports: `blueprint create report "<topic>"`

Ordinary Q&A, coding, debugging, and PR work use chat and the working tree.
Existing blueprints may be optional inputs.

@rules/blueprints.md
@rules/context-budget.md
@rules/harness-compat.md
