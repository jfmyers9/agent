# Intent, Premise, And Approach

Apply once to the whole changeset before line-level candidate generation.

- State the objective and mark it `inferred` when no explicit request, PR body,
  or proposal establishes it.
- Verify that the claimed problem exists and that the change fully addresses
  it rather than narrowing or relocating the failure.
- Check relevant acceptance criteria, contracts, and invariants. Treat a
  proposal as evidence of intent that may itself be incomplete or wrong.
- Decide whether responsibility sits at the correct boundary and whether scope,
  public surface, dependencies, and complexity are proportional to the goal.
- Identify a materially safer or simpler replacement only when evidence shows
  local corrections cannot make the current approach acceptable.

Rate the approach `sound`, `salvageable`, or `misguided`. Use `misguided` only
for a wrong premise or central design that requires replacement; never use it
for style, missing tests, or a collection of locally fixable defects.

Return the objective, premise result, approach rating, decisive evidence, and a
concrete replacement shape when one is required. A bounded failure to meet the
objective, acceptance criteria, or an invariant may return one blocking
reconciliation candidate. Do not generate line-level cleanup findings from this
gate.
