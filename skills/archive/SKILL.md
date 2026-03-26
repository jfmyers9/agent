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
     `~/workspace/blueprints/<project>/*<slug>*` and
     `~/workspace/blueprints/<project>/reviews/*<slug>*`
     (try with/without `.md` extension)
   - If no slug: most recent via
     `{ ls -t ~/workspace/blueprints/<project>/*.md ~/workspace/blueprints/<project>/reviews/*.md; } 2>/dev/null | head -1`
   - If no files found: report "No active blueprints for
     `<project>`" and stop.
3. Archive — destination depends on source location:
   - If source is in `reviews/`: archive to `reviews/archive/`
   - Otherwise: archive to `archive/`
   ```sh
   # For top-level files:
   mkdir -p ~/workspace/blueprints/<project>/archive/
   mv <file> ~/workspace/blueprints/<project>/archive/
   # For reviews/ files:
   mkdir -p ~/workspace/blueprints/<project>/reviews/archive/
   mv <file> ~/workspace/blueprints/<project>/reviews/archive/
   ```
4. Commit per @rules/blueprints.md:
   ```sh
   cd ~/workspace/blueprints && \
     git add -A <project>/ && \
     git commit -m "archive(<project>): <filename>" && \
     git push || (git pull --rebase && git push)
   ```
5. Report: "Archived: `<filename>`"
