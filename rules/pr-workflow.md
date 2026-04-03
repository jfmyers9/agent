# PR & Branch Workflow

- Use Graphite (`gt submit`) for PRs when available, never `gh pr create`
- In non-Graphite repos, use `/commit --push` to commit and push
- Leave PRs in draft unless user explicitly asks to mark ready
- Never close/delete PRs to fix mistakes — update in place
- Never force push unless user explicitly requests it
- Prefer additive fixes over destructive ones on shared resources
- Use `/submit` skill for all PR operations
