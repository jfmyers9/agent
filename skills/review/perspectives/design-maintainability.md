# Design And Maintainability

Apply only when the change adds or moves responsibilities, ownership,
abstractions, public surface, dependencies, or nontrivial control flow.

- Check responsibility placement, cohesion, coupling, and boundary clarity.
- Check mutation ownership, dependency direction, lifecycle, and whether a
  boundary can preserve its invariants.
- Flag indirection, public surface, or coupling only when it creates a concrete
  ownership, failure, or known change-cost risk.
- Reject speculative abstraction and unrelated refactoring as proposed fixes.
- Leave whole-change strategy to the intent and approach gate.

Do not report naming, formatting, readability taste, or a merely cleaner
alternative. For each candidate, return its location, concrete maintenance
risk, evidence, and the smallest bounded correction.
