#!/bin/sh
set -eu
if command -v gt >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	branch=$(git branch --show-current 2>/dev/null || true)
	echo "Graphite workflow active${branch:+ on $branch}: use gt/submit skills for stacked PR work."
else
	echo "Graphite workflow reminder: use the configured submit/start/gt skills when this repo uses stacked branches."
fi
