# Design And Maintainability

Apply to all introduced code.

- Check responsibility placement, cohesion, coupling, and boundary clarity.
- Prefer local, linear flow over unnecessary indirection or public API surface.
- Check naming, error context, mutation ownership, and readability under
  maintenance pressure.
- Reject speculative abstraction and unrelated refactoring.
- Flag complexity only when a simpler approach reduces concrete risk.

For each candidate, return its location, maintenance impact, evidence, and a
scoped alternative.
