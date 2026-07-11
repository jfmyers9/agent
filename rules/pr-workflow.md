# PR & Branch Workflow

- Treat generic `push` requests as raw `git push` requests unless the user
  explicitly invokes `/submit` or asks for Graphite/stack submission.
- Use Graphite (`gt submit`) only for explicit Graphite or stack PR workflows;
  otherwise use ordinary Git/GitHub commands appropriate to the repository.
- Leave PRs in draft unless user explicitly asks to mark ready.
- Never close/delete PRs to fix mistakes — update in place.
- Never force push unless user explicitly requests it.
- Prefer additive fixes over destructive ones on shared resources.
