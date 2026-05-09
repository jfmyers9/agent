# Blueprints Convention

The `blueprint` CLI is the canonical implementation of these
conventions. Skills should use CLI commands instead of inline
boilerplate.

## Project Derivation

Use `blueprint project` to get the project name. Never approximate
from `pwd` or infer from the working directory name — worktrees
and renamed clones will produce wrong results.

```sh
project=$(blueprint project)
```

## Directory Layout

```
~/workspace/blueprints/<project>/spec/       # research-backed proposal specs
~/workspace/blueprints/<project>/plan/       # tactical implementation plans
~/workspace/blueprints/<project>/review/     # code review blueprints
~/workspace/blueprints/<project>/report/     # execution reports
~/workspace/blueprints/<project>/archive/    # consumed blueprints (all types)
```

Directories are created automatically by `blueprint create`.

## Artifact Roles

Use `spec/` for research-backed proposal specs: the durable source of
truth for a new product, architecture, or workflow decision. A spec
blueprint may include a `## Plan` section with execution phases; it does
not need a separate `plan/` file just to be implementable.

Use `plan/` for tactical execution artifacts derived from existing
context: fix batches, PR feedback, debug plans, response drafts,
split-commit plans, and pipeline trackers.

`/skill:implement` may consume approved blueprints from either `spec/`
or `plan/`. The directory identifies artifact role; frontmatter status
identifies whether it is approved for execution.

## Naming

All files use `<epoch>-<slug>.md` where epoch is Unix seconds
(e.g., `1711324800-my-feature.md`). No skill-specific prefixes.

Generate slugs via `blueprint slug "<text>"`.

## Commit-on-Write

Fires after every blueprint file write or move (not just at skill
completion):

```sh
blueprint commit <type> <slug>
```

If `blueprint commit` exits non-zero, STOP and alert the user
with the error output. Blueprint data may be at risk.

## Archive Protocol

Archival is manual. Use `/archive` to move a blueprint to
`archive/` when it is no longer needed in its active directory.

```sh
blueprint archive <slug>
# or for most recent:
blueprint archive
```

## Linking

Use `source` frontmatter to connect related blueprints:

```yaml
---
source: "[[1711324800-my-feature]]"
---
```

- `source`: Obsidian wikilink to the blueprint that triggered this one
- Only added by skills that discover a prior blueprint (review,
  report, fix)
- Obsidian resolves bare filenames across vault directories — no
  path prefix needed
- Creates a directed graph: spec <- review <- fix plan <- report

Skills can add/update source links via:

```sh
blueprint link "$file" "<source-slug>"
```
