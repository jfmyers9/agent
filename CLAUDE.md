# Claude Code Instructions

This file is a Claude Code compatibility entrypoint. Shared agent
instructions live in `AGENTS.md`.

@AGENTS.md

## Claude Code Task Compatibility

When using Claude Code native tasks, mirror portable blueprint state:

- Exploration plans: task `metadata.design`
- Review summaries: task `metadata.notes`
- Task state: task `status` field
- View: `TaskGet(taskId)`
