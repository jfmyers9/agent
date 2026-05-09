---
name: plannotator-annotate
description: >
  Open Plannotator's annotation UI for a markdown file, converted HTML
  file, URL, or folder and then respond to returned annotations. Use
  --gate for approval loops.
argument-hint: "<path-or-url> [--gate]"
---

# Plannotator Annotate

Use this skill when the user wants to annotate a document in
Plannotator instead of reviewing it inline in chat. Use `--gate` when
the document needs explicit approval before work continues.

## Arguments

- `<path-or-url>` — markdown file, HTML file, URL, or folder
- `--gate` — show Approve / Send Annotations / Close controls

## Workflow

Run:

```bash
plannotator annotate <path-or-url> [--gate]
```

Behavior:

1. Launch the command with Bash.
2. Wait for the browser review to finish.
3. If annotations are returned, address them directly.
4. If `--gate` was used and feedback is returned, revise the same file
   and rerun the same gate until approved or dismissed.
5. If `--gate` was used and approval is returned, acknowledge approval
   and continue.
6. If the session closes without feedback or approval, say so briefly
   and stop; do not treat close as approval.

Do not ask the user to paste a shell command into the chat. Run the
command yourself.
