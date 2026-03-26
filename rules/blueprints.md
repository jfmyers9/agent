# Blueprints Convention

## Project Derivation

```sh
basename $(git rev-parse --show-toplevel 2>/dev/null || pwd)
```

## Directory Layout

```
~/workspace/blueprints/<project>/          # active plans
~/workspace/blueprints/<project>/archive/  # consumed plans
~/workspace/blueprints/<project>/reviews/          # review blueprints
~/workspace/blueprints/<project>/reviews/archive/  # consumed reviews
```

Create on first write:
- Plans: `mkdir -p ~/workspace/blueprints/<project>/`
- Reviews: `mkdir -p ~/workspace/blueprints/<project>/reviews/`

## Naming

`<prefix>-<slug>.md` — prefix is skill-specific.
Reviews use epoch-prefixed names: `<epoch>-<slug>.md` (epoch = Unix
seconds, e.g., `1711324800-my-feature.md`).

| Skill       | Prefix        |
|-------------|---------------|
| research    | (none)        |
| review      | `<epoch>-` in `reviews/` subdir |
| fix         | `fix-`        |
| pr-plan     | `pr-plan-`    |
| respond     | `respond-pr-` |
| implement   | (none/consumer) |

## Commit-on-Exit

Fires once at skill completion, not per-write:

```sh
cd ~/workspace/blueprints && \
  git add -A <project>/ && \
  git commit -m "<type>(<project>): <slug>" && \
  git push || (git pull --rebase && git push)
```

## Archive Protocol

When a blueprint is consumed by a downstream skill:

```sh
mkdir -p ~/workspace/blueprints/<project>/archive/
mv ~/workspace/blueprints/<project>/<plan-file> \
   ~/workspace/blueprints/<project>/archive/
```

### Review Archive

Review blueprints use their own archive path:

```sh
mkdir -p ~/workspace/blueprints/<project>/reviews/archive/
mv ~/workspace/blueprints/<project>/reviews/<review-file> \
   ~/workspace/blueprints/<project>/reviews/archive/
```

Archive commit is folded into the same exit commit.
