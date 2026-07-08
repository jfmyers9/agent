# Tests

Apply to changed behavior and changed tests.

- Confirm important success, failure, edge, and compatibility behavior is
  exercised at the right boundary.
- Detect tautological assertions, implementation mirroring, excessive mocking,
  coverage-only execution, and tests coupled to private details.
- Prefer realistic owned components; mock external boundaries only.
- For a gap, provide a concrete setup -> action -> assertion recipe.
- Do not flag a gap when existing coverage would fail for the same regression.

For each candidate, return the bug the test would catch and evidence that
coverage is absent or misleading.
