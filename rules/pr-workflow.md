# PR & Branch Workflow

- Treat generic `push` requests as raw `git push` requests.
- Use native GitHub stacks for stacked PR workflows, with ordinary Git and
  GitHub CLI (`gh`) commands.
- Leave PRs in draft unless user explicitly asks to mark ready.
- Never close/delete PRs to fix mistakes — update in place.
- Never force push unless user explicitly requests it.
- Prefer additive fixes over destructive ones on shared resources.
