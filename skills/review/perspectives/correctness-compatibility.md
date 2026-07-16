# Correctness And Compatibility

Apply to behavior-affecting code, configuration, schemas, and migrations.

- Trace actual control, data, and state flow, including errors, asynchronous
  yields, and input/output boundaries.
- Check callers and consumers for changed behavior, defaults, schemas, and API
  contracts.
- Apply language and framework rules only when they affect behavior,
  compatibility, ownership, lifetime, or safety.
- Probe an edge case only when a changed boundary, existing caller, stated
  contract, or changed invariant admits it.
- Keep only reproducible or source-proven issues introduced by the change.

For each candidate, return its location, concrete impact, evidence, and the
smallest safe correction.
