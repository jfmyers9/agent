# Correctness And Compatibility

Apply to all introduced production code.

- Trace actual control, data, and state flow, including errors, asynchronous
  yields, and input/output boundaries.
- Check callers and consumers for changed behavior, defaults, schemas, and API
  contracts.
- Apply relevant language and framework idioms, ownership/lifetime rules, and
  known footguns.
- Probe or reason through empty, malformed, duplicate, large, concurrent, and
  partial-failure inputs when relevant.
- Keep only reproducible or source-proven issues introduced by the change.

For each candidate, return its location, concrete impact, evidence, and the
smallest safe correction.
