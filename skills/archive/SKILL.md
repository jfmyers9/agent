---
name: archive
description: >
  Archive a blueprint file. Moves the most recent (or specified)
  plan file to archive/ and commits. Triggers: /archive,
  "archive this blueprint", "archive plan".
allowed-tools: Bash, Glob
argument-hint: "[slug]"
---

# Archive

Move a blueprint to `archive/` and commit.

## Arguments

- `[slug]` — filename or partial match (optional, defaults to
  most recent)

## Steps

1. Determine `<project>` per @rules/blueprints.md.
2. Resolve target file:
   - If slug provided: match against
     `~/workspace/blueprints/<project>/spec/*<slug>*`,
     `~/workspace/blueprints/<project>/plan/*<slug>*`, and
     `~/workspace/blueprints/<project>/review/*<slug>*`
     (try with/without `.md` extension)
   - If no slug: most recent via
     `{ ls -t ~/workspace/blueprints/<project>/spec/*.md ~/workspace/blueprints/<project>/plan/*.md ~/workspace/blueprints/<project>/review/*.md; } 2>/dev/null | head -1`
   - If no files found: report "No active blueprints for
     `<project>`" and stop.
3. Archive — unified destination for all types:
   ```sh
   mkdir -p ~/workspace/blueprints/<project>/archive/
   mv <file> ~/workspace/blueprints/<project>/archive/
   ```
4. Commit-on-Write per @rules/blueprints.md:
   ```sh
   cd ~/workspace/blueprints && \
     git add -A <project>/ && \
     git commit -m "archive(<project>): <filename>" && \
     git push || (git pull --rebase && git push)
   ```
   If rebase fails, STOP and alert the user.
5. Report: "Archived: `<filename>`"
