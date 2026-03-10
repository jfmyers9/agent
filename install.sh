#!/bin/bash
set -e

USE_LOCAL=false
if [ "$1" = "--local" ]; then
  USE_LOCAL=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

mkdir -p "$CLAUDE_DIR"

# Files and directories to symlink
items=(
  "CLAUDE.md"
  "settings.json"
  "statusline.py"
  "skills"
  "rules"
)

for item in "${items[@]}"; do
  src="$SCRIPT_DIR/$item"
  dest="$CLAUDE_DIR/$item"

  # --local: symlink settings.json to settings.local.json so the
  # system can manage ~/.claude/settings.json independently
  if [ "$item" = "settings.json" ] && [ "$USE_LOCAL" = true ]; then
    dest="$CLAUDE_DIR/settings.local.json"
  fi

  if [ -e "$src" ]; then
    rm -rf "$dest"
    ln -sf "$src" "$dest"
    echo "Linked: $dest"
  fi
done

echo "Done"
