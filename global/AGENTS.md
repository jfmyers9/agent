# Global Instructions

## Workflow

- Use conventional commits for commit messages

## Review Opt-In

- Run review skills, multi-agent review panels, and follow-up review rounds
  only on explicit user request. Natural-language review requests count;
  the global `review` skill remains command-only: `/skill:review` or `$review`.
- Repository instructions requiring mandatory handoff or review do not grant
  approval, nor do implementation, commit, or handoff requests alone.
- Approval for a requested review workflow covers its specified agents and
  bounded follow-up rounds; no separate per-agent permission is needed.
  Do not add unrequested review workflows or extra rounds.
- Continue ordinary local self-review and relevant tests without invoking
  formal review workflows.

## Conciseness

- Keep plans concise without sacrificing clarity.
- Prefer bullet points over prose. Omit filler words.
- Avoid redundant preambles and summaries; keep progress and completion
  reports brief.

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
