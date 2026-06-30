# Correctness And Compatibility

Apply to all introduced production code.

- Trace actual control/data/state flow, including errors, async yields, and
  boundary values.
- Check callers and consumers for behavior, default, schema, and API changes.
- Check language/framework idioms, ownership/lifetime rules, and known
  footguns.
- Test empty, malformed, duplicate, large, concurrent, and partial-failure
  inputs when relevant.
- Keep only reproducible or source-proven issues introduced by the change.

Return file/line, concrete impact, evidence, and smallest safe correction.
