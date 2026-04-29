# Project Instructions

This repository is the source of truth for shared coding-agent workflow
configuration plus harness adapters.

- Edit files in this repo, not generated/symlinked files under
  `~/.claude` or `~/.pi/agent`
- Shared instructions live in `AGENTS.md`
- Claude-specific config lives in `harnesses/claude/`
- Pi-specific config lives in `harnesses/pi/`
- Non-symlinked additions must be added to `install.sh`

## Multi-Phase Implementation Guidelines

When planning complex features, structure the "Next Steps" section
with explicit phase markers:

- `**Phase N: Description**`
- `### Phase N: Description`

Guidelines:

- 3-7 phases is ideal
- Each phase independently reviewable/testable
- Natural breakpoints: setup, implementation, testing, docs
- Phases build sequentially unless marked independent
