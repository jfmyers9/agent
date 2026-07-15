---
paths:
  - "**/*test*"
  - "**/*spec*"
---

# Test Quality

Every test should answer: **"What bug would this catch?"**
If there is no realistic bug scenario or distinct diagnostic value, do not add
it. Remove existing tests only after confirming they protect no separate layer,
contract, or failure signal.

## Banned Patterns

- **Tautology tests** — testing that mocks return what you told
  them to return
- **Getter/setter tests** — testing that assignment works
- **Implementation mirroring** — duplicating the production
  formula in the test instead of using known-answer values
- **Happy-path-only** — only testing success when failure modes
  exist (empty input, invalid data, timeouts)
- **Coverage padding** — executing code without asserting
  meaningful outcomes

## What to Test

- Boundary conditions (empty, one, many, overflow)
- Error paths (invalid input, network failure, timeout,
  permission denied)
- State transitions (A->B allowed, A->C forbidden)
- Race conditions and ordering dependencies
- Integration between real components

## Mock Discipline

Mocks are a last resort:

- Mock external services (network, filesystem, clock,
  third-party APIs)
- Do NOT mock the thing you're testing
- Prefer real owned collaborators. Mock one only when the boundary itself is
  the contract or the real integration would be unsafe or nondeterministic.
- Several mocks in one test are a coupling signal. Prefer a simpler seam when
  it reduces setup without weakening the exercised contract.

## The Deletion Test

After writing a test, ask: "If I delete this test and introduce a bug, will any
other test fail with an equally local and useful signal?" If yes, consider
removing it. Keep deliberate overlap across unit, integration, and acceptance
boundaries when each layer diagnoses a different contract.
