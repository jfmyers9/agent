# Human Approval Gates

Approval gates apply only to proposal-producing research.

## Protocol

1. Write one `proposal/` artifact with status `draft`.
2. Commit it and report its path.
3. Wait for explicit approval, feedback, or `$implement <proposal>`.
4. Approval or explicit implementation advances it to `approved` immediately.
5. Feedback revises the same proposal and leaves it `draft`.
6. Successful implementation advances it to `complete`.

`--auto` may advance a proposal directly to `approved`. Reviews and reports are
complete when generated and require no status approval loop.
