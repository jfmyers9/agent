# Tests

Apply to changed behavior and changed tests.

- Confirm important success, failure, edge, and compatibility behavior is
  exercised at the right boundary.
- Detect tautological assertions, implementation mirroring, excessive mocking,
  coverage-only execution, and tests coupled to private details.
- Prefer realistic owned components; mock external boundaries only.
- For gaps, provide a concrete setup -> action -> assertion recipe.
- Do not demand tests whose failure would duplicate existing coverage.

Return the bug the test would catch and evidence that coverage is absent or
misleading.
