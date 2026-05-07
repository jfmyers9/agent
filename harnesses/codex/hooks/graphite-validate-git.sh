#!/bin/sh
set -eu

CODEX_HOOK_PAYLOAD=$(cat)
export CODEX_HOOK_PAYLOAD

python3 - <<'PY'
import json
import os
import shlex
import sys

raw = os.environ.get("CODEX_HOOK_PAYLOAD", "")
try:
    payload = json.loads(raw) if raw.strip() else {}
except json.JSONDecodeError:
    raise SystemExit(0)

command = None
stack = [payload]
while stack and command is None:
    value = stack.pop()
    if not isinstance(value, dict):
        continue

    for key in ("command", "cmd"):
        candidate = value.get(key)
        if isinstance(candidate, str):
            command = candidate
            break

    if command is not None:
        break

    for key in ("tool_input", "toolInput", "input", "args", "parameters"):
        child = value.get(key)
        if isinstance(child, dict):
            stack.append(child)

if not command:
    raise SystemExit(0)

try:
    tokens = shlex.split(command)
except ValueError:
    raise SystemExit(0)

reason = None
if len(tokens) >= 2 and tokens[0] == "git":
    subcommand = tokens[1]
    if subcommand in {"push", "rebase"}:
        reason = f"Use the Graphite workflow/gt skill instead of raw `git {subcommand}`."
    elif subcommand == "checkout" and "-b" in tokens[2:]:
        reason = "Use the start/gt workflow instead of raw `git checkout -b`."
    elif subcommand == "switch" and "-c" in tokens[2:]:
        reason = "Use the start/gt workflow instead of raw `git switch -c`."
elif tokens[:3] == ["gh", "pr", "create"]:
    reason = "Use the submit workflow instead of raw `gh pr create`."

if reason is None:
    raise SystemExit(0)

sys.stdout.write(json.dumps({"decision": "block", "reason": reason}))
sys.stdout.write("\n")
raise SystemExit(2)
PY
