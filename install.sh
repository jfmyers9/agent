#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${1:-claude}"

link_item() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest"
  ln -sf "$src" "$dest"
  echo "Linked: $dest"
}

install_shared_bin() {
  mkdir -p "$HOME/.local/bin"
  link_item "$SCRIPT_DIR/bin/blueprint" "$HOME/.local/bin/blueprint"
}

install_claude() {
  local dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  mkdir -p "$dir"

  link_item "$SCRIPT_DIR/CLAUDE.md" "$dir/CLAUDE.md"
  link_item "$SCRIPT_DIR/AGENTS.md" "$dir/AGENTS.md"
  link_item "$SCRIPT_DIR/rules" "$dir/rules"
  link_item "$SCRIPT_DIR/skills" "$dir/skills"
  link_item "$SCRIPT_DIR/harnesses/claude/settings.json" "$dir/settings.json"
  link_item "$SCRIPT_DIR/harnesses/claude/statusline.py" "$dir/statusline.py"

  mkdir -p "$dir/hooks"
  for hook in "$SCRIPT_DIR/harnesses/claude/hooks/"*; do
    [ -f "$hook" ] || continue
    link_item "$hook" "$dir/hooks/$(basename "$hook")"
  done
}

install_pi() {
  local dir="${PI_CONFIG_DIR:-$HOME/.pi/agent}"
  mkdir -p "$dir"

  link_item "$SCRIPT_DIR/AGENTS.md" "$dir/AGENTS.md"
  link_item "$SCRIPT_DIR/rules" "$dir/rules"
  link_item "$SCRIPT_DIR/skills" "$dir/skills"
  link_item "$SCRIPT_DIR/harnesses/pi/settings.json" "$dir/settings.json"

  mkdir -p "$dir/extensions"
  for extension in "$SCRIPT_DIR/harnesses/pi/extensions/"*; do
    [ -e "$extension" ] || continue
    link_item "$extension" "$dir/extensions/$(basename "$extension")"
  done
}

case "$HARNESS" in
  claude)
    install_claude
    install_shared_bin
    ;;
  pi)
    install_pi
    install_shared_bin
    ;;
  all)
    install_claude
    install_pi
    install_shared_bin
    ;;
  *)
    echo "Usage: $0 [claude|pi|all]" >&2
    exit 1
    ;;
esac

echo "Done"
