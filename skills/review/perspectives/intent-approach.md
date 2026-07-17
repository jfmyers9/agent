# Intent, Premise, And Approach

Apply once to the whole changeset before line-level candidate generation.

- State the objective and mark it `inferred` when no explicit request, PR body,
  or proposal establishes it.
- Verify that the claimed problem exists and that the change fully addresses
  it rather than narrowing or relocating the failure.
- Check relevant acceptance criteria, contracts, and invariants. Treat a
  proposal as evidence of intent that may itself be incomplete or wrong.
- When an explicit intent source exists, preserve every criterion and non-goal;
  do not evaluate only the subset represented in the diff.
- Decide whether responsibility sits at the correct boundary and whether scope,
  public surface, dependencies, and complexity are proportional to the goal.
- Treat new public options, defaults, and authorization gates as product
  decisions. Verify that the intent source requires them and that their default
  behavior matches the requested experience; do not promote an internal switch
  into a user contract merely because it is the shortest implementation path.
- Identify a materially safer or simpler replacement only when evidence shows
  local corrections cannot make the current approach acceptable.

Rate the approach `sound`, `salvageable`, or `misguided`. Use `misguided` only
for a wrong premise or central design that requires replacement; never use it
for style, missing tests, or a collection of locally fixable defects.

Return the objective, criterion-by-criterion status, premise result, approach
rating, decisive evidence, and a concrete replacement shape when one is
required. A bounded failure to meet the objective, acceptance criteria, or an
invariant may return one blocking reconciliation candidate. Describe its
required behavior without inventing a public control unless intent or safety
requires that control. Do not generate line-level cleanup findings from this
gate.
