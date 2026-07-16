# Tests And Verification

Apply when observable behavior or tests changed, or when a finding needs
regression proof.

- Require a named regression path before reporting missing coverage. Do not
  demand exhaustive success, failure, and edge-case tests by default.
- Flag tautological assertions, implementation mirroring, mocks, nondeterminism,
  or private-detail coupling only when they can mask that regression, create
  realistic flakiness, or block ordinary behavior-preserving change.
- Judge mocks by whether they preserve the contract under test, not by whether
  the collaborator is internally or externally owned.
- For a gap, provide a concrete setup -> action -> assertion recipe.
- Do not flag a gap when existing coverage would fail for the same regression.

Fold a test gap into its underlying functional finding. Return a standalone
candidate only when the tests themselves provide false confidence or the
claimed behavior otherwise has no credible verification.
