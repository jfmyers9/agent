#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ACTION="install"
HARNESS="all"

case "${1:-}" in
install | dry-run | doctor | validate | unlink)
	ACTION="$1"
	HARNESS="${2:-all}"
	;;
claude | pi | codex | all)
	HARNESS="$1"
	;;
"") ;;
*)
	echo "Usage: $0 [install|dry-run|doctor|validate|unlink] [claude|pi|codex|all]" >&2
	exit 2
	;;
esac

case "$HARNESS" in
claude | pi | codex | all) ;;
*)
	echo "Unknown harness: $HARNESS" >&2
	exit 2
	;;
esac

SOURCES=()
DESTINATIONS=()
KINDS=()
CLEAN_SOURCE_DIRS=()
CLEAN_DESTINATION_DIRS=()

add_link() {
	SOURCES+=("$1")
	DESTINATIONS+=("$2")
	KINDS+=("link")
}

add_clean_dir() {
	CLEAN_SOURCE_DIRS+=("$1")
	CLEAN_DESTINATION_DIRS+=("$2")
}

add_link_once() {
	local destination existing
	destination="$2"
	for existing in "${DESTINATIONS[@]}"; do
		[ "$existing" = "$destination" ] && return
	done
	add_link "$1" "$2"
}

pi_configured_extensions() {
	local settings="$1"
	if ! command -v node >/dev/null 2>&1; then
		if [ "$ACTION" = "doctor" ]; then
			return 0
		fi
		echo "Error: node is required to read Pi extension settings." >&2
		exit 1
	fi
	node -e '
const fs = require("fs");
const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const extension of settings.extensions ?? []) {
	if (typeof extension !== "string") continue;
	console.log(extension);
}
' "$settings"
}

add_seed() {
	SOURCES+=("$1")
	DESTINATIONS+=("$2")
	KINDS+=("seed")
}

plan_claude() {
	local dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
	add_link "$SCRIPT_DIR/global/CLAUDE.md" "$dir/CLAUDE.md"
	add_link "$SCRIPT_DIR/global/AGENTS.md" "$dir/AGENTS.md"
	add_link "$SCRIPT_DIR/rules" "$dir/rules"
	add_link "$SCRIPT_DIR/skills" "$dir/skills"
	add_link "$SCRIPT_DIR/harnesses/claude/settings.json" "$dir/settings.json"
	add_link "$SCRIPT_DIR/harnesses/claude/statusline.py" "$dir/statusline.py"
	local hook
	for hook in "$SCRIPT_DIR/harnesses/claude/hooks/"*; do
		[ -f "$hook" ] || continue
		add_link "$hook" "$dir/hooks/$(basename "$hook")"
	done
}

plan_pi() {
	local dir="${PI_CONFIG_DIR:-$HOME/.pi/agent}"
	add_link "$SCRIPT_DIR/global/AGENTS.md" "$dir/AGENTS.md"
	add_link "$SCRIPT_DIR/rules" "$dir/rules"
	add_link "$SCRIPT_DIR/skills" "$dir/skills"
	add_link "$SCRIPT_DIR/harnesses/pi/settings.json" "$dir/settings.json"
	local config
	for config in keybindings.json tui.json effort.json models.json; do
		[ -f "$SCRIPT_DIR/harnesses/pi/$config" ] || continue
		add_link "$SCRIPT_DIR/harnesses/pi/$config" "$dir/$config"
	done
	local extension extension_name
	while IFS= read -r extension; do
		[ -n "$extension" ] || continue
		case "$extension" in
		"extensions/"*".."*)
			echo "Invalid Pi extension path: $extension" >&2
			exit 1
			;;
		"extensions/"*) ;;
		*)
			echo "Invalid Pi extension path: $extension" >&2
			exit 1
			;;
		esac
		extension_name="${extension#extensions/}"
		extension_name="${extension_name%%/*}"
		add_link_once "$SCRIPT_DIR/harnesses/pi/extensions/$extension_name" "$dir/extensions/$extension_name"
	done < <(pi_configured_extensions "$SCRIPT_DIR/harnesses/pi/settings.json")
	add_link_once "$SCRIPT_DIR/harnesses/pi/extensions/shared" "$dir/extensions/shared"
	add_clean_dir "$SCRIPT_DIR/harnesses/pi/extensions" "$dir/extensions"
	add_link "$SCRIPT_DIR/node_modules" "$dir/node_modules"
	add_link "$SCRIPT_DIR/target/release/context-guard" "$HOME/.local/bin/context-guard"
}

plan_codex() {
	local dir="${CODEX_CONFIG_DIR:-$HOME/.codex}"
	local agents_dir="${CODEX_AGENTS_DIR:-$HOME/.agents}"
	add_seed "$SCRIPT_DIR/harnesses/codex/config.toml" "$dir/config.toml"
	if [ -f "$SCRIPT_DIR/harnesses/codex/hooks.json" ]; then
		add_link "$SCRIPT_DIR/harnesses/codex/hooks.json" "$dir/hooks.json"
	fi
	local hook
	for hook in "$SCRIPT_DIR/harnesses/codex/hooks/"*; do
		[ -f "$hook" ] || continue
		add_link "$hook" "$dir/hooks/$(basename "$hook")"
	done
	add_link "$SCRIPT_DIR/global/AGENTS.md" "$dir/AGENTS.md"
	add_link "$SCRIPT_DIR/rules" "$dir/rules-md"
	add_link "$SCRIPT_DIR/skills" "$agents_dir/skills"
	add_link "$SCRIPT_DIR/rules" "$agents_dir/rules"
}

build_plan() {
	case "$HARNESS" in
	claude) plan_claude ;;
	pi) plan_pi ;;
	codex) plan_codex ;;
	all)
		plan_claude
		plan_pi
		plan_codex
		;;
	esac
	add_link "$SCRIPT_DIR/bin/blueprint" "$HOME/.local/bin/blueprint"
	add_link "$SCRIPT_DIR/bin/git-surgeon.ts" "$HOME/.local/bin/git-surgeon"
}

is_owned_link() {
	[ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]
}

is_legacy_owned_link() {
	local source="$1"
	local destination="$2"
	local legacy_source
	case "$source" in
	"$SCRIPT_DIR/global/AGENTS.md") legacy_source="$SCRIPT_DIR/AGENTS.md" ;;
	"$SCRIPT_DIR/global/CLAUDE.md") legacy_source="$SCRIPT_DIR/CLAUDE.md" ;;
	*) return 1 ;;
	esac
	[ -L "$destination" ] && [ "$(readlink "$destination")" = "$legacy_source" ]
}

is_planned_destination() {
	local candidate="$1"
	local destination
	for destination in "${DESTINATIONS[@]}"; do
		[ "$destination" = "$candidate" ] && return 0
	done
	return 1
}

is_cleanable_link() {
	local source_dir="$1"
	local link="$2"
	local target
	[ -L "$link" ] || return 1
	target="$(readlink "$link")"
	case "$target" in
	"$source_dir"/*) return 0 ;;
	*) return 1 ;;
	esac
}

print_stale_links() {
	local index source_dir destination_dir entry
	for ((index = 0; index < ${#CLEAN_SOURCE_DIRS[@]}; index++)); do
		source_dir="${CLEAN_SOURCE_DIRS[$index]}"
		destination_dir="${CLEAN_DESTINATION_DIRS[$index]}"
		[ -d "$destination_dir" ] && [ ! -L "$destination_dir" ] || continue
		for entry in "$destination_dir"/*; do
			[ -e "$entry" ] || [ -L "$entry" ] || continue
			is_planned_destination "$entry" && continue
			if is_cleanable_link "$source_dir" "$entry"; then
				echo "Would remove stale: $entry -> $(readlink "$entry")"
			fi
		done
	done
}

remove_stale_links() {
	local label="$1"
	local index source_dir destination_dir entry target
	for ((index = 0; index < ${#CLEAN_SOURCE_DIRS[@]}; index++)); do
		source_dir="${CLEAN_SOURCE_DIRS[$index]}"
		destination_dir="${CLEAN_DESTINATION_DIRS[$index]}"
		[ -d "$destination_dir" ] && [ ! -L "$destination_dir" ] || continue
		for entry in "$destination_dir"/*; do
			[ -e "$entry" ] || [ -L "$entry" ] || continue
			is_planned_destination "$entry" && continue
			if is_cleanable_link "$source_dir" "$entry"; then
				target="$(readlink "$entry")"
				rm "$entry"
				echo "$label: $entry -> $target"
			fi
		done
	done
}

validate_no_stale_links() {
	local failed=0
	local index source_dir destination_dir entry
	for ((index = 0; index < ${#CLEAN_SOURCE_DIRS[@]}; index++)); do
		source_dir="${CLEAN_SOURCE_DIRS[$index]}"
		destination_dir="${CLEAN_DESTINATION_DIRS[$index]}"
		[ -d "$destination_dir" ] && [ ! -L "$destination_dir" ] || continue
		for entry in "$destination_dir"/*; do
			[ -e "$entry" ] || [ -L "$entry" ] || continue
			is_planned_destination "$entry" && continue
			if is_cleanable_link "$source_dir" "$entry"; then
				echo "Invalid install: stale owned link remains at $entry -> $(readlink "$entry")" >&2
				failed=1
			fi
		done
	done
	[ "$failed" -eq 0 ]
}

preflight_targets() {
	local failed=0
	local index source destination kind
	for ((index = 0; index < ${#SOURCES[@]}; index++)); do
		source="${SOURCES[$index]}"
		destination="${DESTINATIONS[$index]}"
		kind="${KINDS[$index]}"
		if [ "$kind" = "seed" ]; then
			if [ -L "$destination" ] || [ -d "$destination" ]; then
				echo "Conflict: $destination must be absent or a regular file; leaving it untouched." >&2
				failed=1
			fi
			continue
		fi
		if is_owned_link "$source" "$destination" || is_legacy_owned_link "$source" "$destination"; then
			continue
		fi
		if [ -L "$destination" ]; then
			echo "Conflict: $destination is a foreign symlink; leaving it untouched." >&2
			failed=1
		elif [ -e "$destination" ]; then
			echo "Conflict: $destination already exists; leaving it untouched." >&2
			failed=1
		fi
	done
	[ "$failed" -eq 0 ]
}

preflight_sources() {
	local failed=0
	local source
	for source in "${SOURCES[@]}"; do
		if [ ! -e "$source" ]; then
			echo "Missing install source: $source" >&2
			failed=1
		fi
	done
	[ "$failed" -eq 0 ]
}

run_bun_install() {
	if command -v mise >/dev/null 2>&1; then
		(cd "$SCRIPT_DIR" && mise exec -- bun install --frozen-lockfile)
	elif command -v bun >/dev/null 2>&1; then
		(cd "$SCRIPT_DIR" && bun install --frozen-lockfile)
	else
		echo "Error: Bun is required. Install the pinned toolchain with 'mise install'." >&2
		exit 1
	fi
}

prepare_pi() {
	if ! command -v cargo >/dev/null 2>&1; then
		echo "Error: cargo is required to build Context Guard for Pi." >&2
		exit 1
	fi
	run_bun_install
	echo "Building Context Guard core..."
	(cd "$SCRIPT_DIR" && cargo build --release -p context-guard)
}

prepare_install() {
	case "$HARNESS" in
	pi | all) prepare_pi ;;
	esac
}

apply_plan() {
	local index source destination kind
	for ((index = 0; index < ${#SOURCES[@]}; index++)); do
		source="${SOURCES[$index]}"
		destination="${DESTINATIONS[$index]}"
		kind="${KINDS[$index]}"
		if [ "$kind" = "seed" ]; then
			if [ -f "$destination" ]; then
				echo "Preserved: $destination"
			else
				mkdir -p "$(dirname "$destination")"
				cp -p "$source" "$destination"
				echo "Seeded: $destination"
			fi
		elif is_owned_link "$source" "$destination"; then
			echo "Up to date: $destination"
		elif is_legacy_owned_link "$source" "$destination"; then
			rm "$destination"
			ln -s "$source" "$destination"
			echo "Relinked: $destination"
		else
			mkdir -p "$(dirname "$destination")"
			ln -s "$source" "$destination"
			echo "Linked: $destination"
		fi
	done
}

print_plan() {
	local index source destination kind
	for ((index = 0; index < ${#SOURCES[@]}; index++)); do
		source="${SOURCES[$index]}"
		destination="${DESTINATIONS[$index]}"
		kind="${KINDS[$index]}"
		if [ "$kind" = "seed" ]; then
			if [ -f "$destination" ]; then
				echo "Would preserve: $destination"
			else
				echo "Would seed: $destination"
			fi
		elif is_owned_link "$source" "$destination"; then
			echo "Up to date: $destination"
		elif is_legacy_owned_link "$source" "$destination"; then
			echo "Would relink: $destination -> $source"
		else
			echo "Would link: $destination -> $source"
		fi
	done
}

unlink_plan() {
	local index source destination kind
	for ((index = ${#SOURCES[@]} - 1; index >= 0; index--)); do
		source="${SOURCES[$index]}"
		destination="${DESTINATIONS[$index]}"
		kind="${KINDS[$index]}"
		if [ "$kind" = "seed" ]; then
			echo "Preserved: $destination"
		elif is_owned_link "$source" "$destination" || is_legacy_owned_link "$source" "$destination"; then
			rm "$destination"
			echo "Unlinked: $destination"
		elif [ -e "$destination" ] || [ -L "$destination" ]; then
			echo "Skipped non-owned: $destination"
		fi
	done
}

validate_json_sources() {
	if ! command -v node >/dev/null 2>&1; then
		echo "Error: node is required to validate JSON configuration." >&2
		return 1
	fi
	local files=(
		"$SCRIPT_DIR/harnesses/claude/settings.json"
		"$SCRIPT_DIR/harnesses/pi/settings.json"
		"$SCRIPT_DIR/harnesses/pi/keybindings.json"
		"$SCRIPT_DIR/harnesses/pi/tui.json"
		"$SCRIPT_DIR/harnesses/pi/effort.json"
		"$SCRIPT_DIR/harnesses/codex/hooks.json"
	)
	node -e 'const fs = require("fs"); for (const file of process.argv.slice(1)) JSON.parse(fs.readFileSync(file, "utf8"));' "${files[@]}"
}

validate_install() {
	validate_json_sources
	local failed=0
	local index source destination kind
	for ((index = 0; index < ${#SOURCES[@]}; index++)); do
		source="${SOURCES[$index]}"
		destination="${DESTINATIONS[$index]}"
		kind="${KINDS[$index]}"
		if [ "$kind" = "seed" ]; then
			if [ ! -f "$destination" ] || [ -L "$destination" ]; then
				echo "Invalid install: $destination is not a mutable regular file." >&2
				failed=1
			fi
		elif ! is_owned_link "$source" "$destination" || [ ! -e "$destination" ]; then
			echo "Invalid install: $destination does not resolve to $source." >&2
			failed=1
		fi
	done
	validate_no_stale_links || failed=1
	[ "$failed" -eq 0 ]
}

doctor() {
	local failed=0
	local command
	for command in git node bun; do
		if ! command -v "$command" >/dev/null 2>&1; then
			echo "Missing required command: $command" >&2
			failed=1
		fi
	done
	case "$HARNESS" in
	claude | all)
		command -v python3 >/dev/null 2>&1 || {
			echo "Missing required command for Claude: python3" >&2
			failed=1
		}
		;;
	esac
	case "$HARNESS" in
	pi | all)
		command -v cargo >/dev/null 2>&1 || {
			echo "Missing required command for Pi: cargo" >&2
			failed=1
		}
		if ! command -v mise >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
			echo "Missing required command for Pi: mise or bun" >&2
			failed=1
		fi
		;;
	esac
	local probe_dir
	probe_dir="$(mktemp -d)"
	if ! ln -s "$probe_dir/source" "$probe_dir/link" 2>/dev/null; then
		echo "Symlink creation is unavailable in $probe_dir." >&2
		failed=1
	fi
	rm -rf "$probe_dir"
	local source
	for source in "${SOURCES[@]}"; do
		case "$source" in
		"$SCRIPT_DIR/node_modules" | "$SCRIPT_DIR/target/release/context-guard") continue ;;
		esac
		if [ ! -e "$source" ]; then
			echo "Missing install source: $source" >&2
			failed=1
		fi
	done
	[ -f "$SCRIPT_DIR/package.json" ] || {
		echo "Missing Pi dependency manifest: $SCRIPT_DIR/package.json" >&2
		failed=1
	}
	[ -f "$SCRIPT_DIR/crates/context-guard/Cargo.toml" ] || {
		echo "Missing Context Guard crate." >&2
		failed=1
	}
	[ "$failed" -eq 0 ]
}

build_plan

case "$ACTION" in
install)
	preflight_targets
	prepare_install
	preflight_sources
	remove_stale_links "Removed stale"
	apply_plan
	validate_install
	;;
dry-run)
	preflight_targets
	print_stale_links
	print_plan
	;;
doctor) doctor ;;
validate) validate_install ;;
unlink)
	remove_stale_links "Unlinked stale"
	unlink_plan
	;;
esac

echo "Done"
