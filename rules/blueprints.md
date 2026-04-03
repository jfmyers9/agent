# Blueprints Convention

## Project Derivation

```sh
basename "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||; s|/\.bare$||')" 2>/dev/null || basename "$(pwd)"
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

When a blueprint is consumed by a downstream skill:

```sh
mkdir -p ~/workspace/blueprints/<project>/archive/
mv ~/workspace/blueprints/<project>/<type>/<file> \
   ~/workspace/blueprints/<project>/archive/
```
