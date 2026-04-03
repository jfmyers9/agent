# Blueprints Convention

## Project Derivation

**MUST execute via Bash** — never approximate from `pwd` or infer
from the working directory name. Worktrees and renamed clones
will produce wrong results otherwise.

```sh
basename "$(git remote get-url origin 2>/dev/null | sed 's|\.git$||')" 2>/dev/null || basename "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||; s|/\.bare$||')" 2>/dev/null || basename "$(pwd)"
```

## Directory Layout

```
~/workspace/blueprints/<project>/spec/       # research specs
~/workspace/blueprints/<project>/plan/       # implementation plans (fix, pr-plan, respond)
~/workspace/blueprints/<project>/review/     # code review blueprints
~/workspace/blueprints/<project>/archive/    # consumed blueprints (all types)
```

Create on first write: `mkdir -p ~/workspace/blueprints/<project>/<type>/`

## Naming

All files use `<epoch>-<slug>.md` where epoch is Unix seconds
(e.g., `1711324800-my-feature.md`). No skill-specific prefixes.

## Commit-on-Write

Fires after every blueprint file write or move (not just at skill
completion):

```sh
cd ~/workspace/blueprints && \
  git add -A <project>/ && \
  git commit -m "<type>(<project>): <slug>" && \
  git push || (git pull --rebase && git push)
```

If rebase fails, STOP and alert the user immediately with conflict
details. Do not continue the skill — blueprint data may be at risk.

## Archive Protocol

Archival is manual. Use `/archive` to move a blueprint to
`archive/` when it is no longer needed in its active directory.
