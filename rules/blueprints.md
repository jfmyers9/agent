# Blueprints Convention

## Project Derivation

```sh
basename $(git rev-parse --show-toplevel 2>/dev/null || pwd)
```

## Directory Layout

```
~/workspace/blueprints/<project>/          # active plans
~/workspace/blueprints/<project>/archive/  # consumed plans
```

Create on first write: `mkdir -p ~/workspace/blueprints/<project>/`

## Naming

`<prefix>-<slug>.md` — prefix is skill-specific:

| Skill       | Prefix        |
|-------------|---------------|
| research    | (none)        |
| review      | `review-`     |
| fix         | `fix-`        |
| pr-plan     | `pr-plan-`    |
| respond     | `respond-pr-` |
| implement   | (none/consumer) |

## Commit-on-Exit

Fires once at skill completion, not per-write:

```sh
cd ~/workspace/blueprints && \
  git add -A <project>/ && \
  git commit -m "<type>(<project>): <slug>"
```

## Archive Protocol

When a blueprint is consumed by a downstream skill:

```sh
mkdir -p ~/workspace/blueprints/<project>/archive/
mv ~/workspace/blueprints/<project>/<plan-file> \
   ~/workspace/blueprints/<project>/archive/
```

Archive commit is folded into the same exit commit.
