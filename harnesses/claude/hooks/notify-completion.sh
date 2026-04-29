#!/usr/bin/env bash
# Claude Code notification hook — marks tmux tab name when work finishes in a background window.
# Also sends macOS notification with branch name and context%.

set -euo pipefail

# Consume stdin (hook protocol requires it)
cat > /dev/null

# Only notify inside tmux
[[ -n "${TMUX:-}" ]] || exit 0

# Skip if current window is active (user is already looking)
window_active=$(tmux display-message -p '#{window_active}' 2>/dev/null) || exit 0
[[ "$window_active" != "1" ]] || exit 0

# Gather context
window_name=$(tmux display-message -p '#{window_name}' 2>/dev/null) || window_name="claude"
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || branch="$window_name"

# Best-effort context% from statusline temp files
ctx=""
latest=$(ls -t /tmp/claude-context-pct-* 2>/dev/null | head -1) || true
if [[ -n "$latest" ]]; then
  ctx=$(cat "$latest" 2>/dev/null) || true
fi

# Mark tab name with ✓ prefix (skip if already marked)
if [[ "$window_name" != ✓* ]]; then
  tmux rename-window "✓ $window_name" 2>/dev/null || true
fi

# macOS notification
title="Claude: $branch"
[[ -n "$ctx" ]] && title="Claude: $branch (${ctx}%)"
osascript -e "display notification \"Done\" with title \"$title\"" 2>/dev/null || true

exit 0
