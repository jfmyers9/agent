# Plannotator Gates

Use Plannotator as the default review surface for non-auto blueprint
approvals.

## Command

```sh
plannotator annotate "$file" --gate
```

Run the command yourself. Do not ask the user to paste it into chat.

## Outcomes

Interpret stdout as:

- `The user approved.` — approval. Advance the relevant blueprint
  status and commit.
- Non-empty feedback/annotations — requested changes. Revise the same
  artifact, commit, and rerun the same gate.
- Empty output — dismissed or closed. Leave status unchanged, stop, and
  report the resume command.

If the command fails or `plannotator` is unavailable, report the error.
For non-auto workflows, fall back to chat approval only when the user
explicitly approves after seeing the failure. Do not silently approve.

## Loop

1. Write or update the blueprint.
2. Run `blueprint commit <type> <slug>`.
3. Run the Plannotator gate.
4. On feedback, edit the same blueprint, add/update `## Approval
History`, commit, and rerun.
5. On approval, update status and commit immediately.

## Automation

`--auto` bypasses human gates for autonomous workflows. It must still
write and commit each blueprint status change.
