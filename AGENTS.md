# Global Instructions

## Workflow

- Use conventional commits for commit messages

## Conciseness

- Make plans extremely concise. Sacrifice grammar for concision.
- Prefer bullet points over prose. Omit filler words.
- In conversation, be direct. Skip preamble and summaries unless
  asked.
- Use Caveman `lite` by default: remove filler, hedging, and pleasantries while
  keeping articles, full sentences, technical terms, code, commands, and error
  text intact. An explicit Caveman level or stop request overrides this default
  for the current session.

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
`research`, `review`, or `diagnose`.

- Proposals: `blueprint create proposal "<topic>"`
- Reviews: `blueprint create review "<topic>"`
- Context/diagnosis reports: `blueprint create report "<topic>" --kind <kind>`

Ordinary Q&A, coding, debugging, and PR work use chat and the working tree.
Existing blueprints may be optional inputs.

@rules/blueprints.md
@rules/context-budget.md
@rules/harness-compat.md
