# Human Approval Gates

Use blueprint files as the default review surface for non-auto workflow approvals.
The user may review those files locally in their editor or Obsidian and reply in
chat with approval or feedback.

## Protocol

1. Write or update the blueprint.
2. Run `blueprint commit <type> <slug>`.
3. Report the blueprint path, status, and requested decision.
4. Stop and wait for the user's chat response unless the workflow is running
   with an explicit `--auto` bypass.

## Outcomes

Interpret the user's chat response as:

- Explicit approval, such as `approve`, `approved`, `lgtm`, or `ship it`:
  advance the relevant blueprint status and commit.
- Requested changes or questions: revise the same artifact, add/update
  `## Approval History`, commit, and return it to review.
- Ambiguous response: ask for clarification. Do not infer approval.
- No response: leave status unchanged and report the resume command.

## Loop

1. Write or update the blueprint.
2. Run `blueprint commit <type> <slug>`.
3. Wait for explicit chat approval or feedback.
4. On feedback, edit the same blueprint, add/update `## Approval History`,
   commit, and return to review.
5. On approval, update status and commit immediately.

## Automation

`--auto` bypasses human gates for autonomous workflows. It must still write and
commit each blueprint status change.
