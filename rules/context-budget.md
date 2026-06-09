# Context Budget

Context window is finite. Treat it like memory — never waste it.

## Rules

- For known file paths, use the active file read tool with ranges or
  limits when available; do not use `sed`, `cat`, `head`, or `tail`
  for file reads just to save tokens
- Pipe verbose command output through `| tail -20` or `| head -50` —
  never dump full logs
- Use `--quiet`, `--summary`, or `-s` flags when available
- Grep for relevant lines instead of reading full output
- If output exceeds ~30 lines, summarize before continuing
- When passing info between workflow phases, pre-compute a summary —
  don't forward raw output
- When writing blueprint notes, include only what future phases need
  and omit everything else
