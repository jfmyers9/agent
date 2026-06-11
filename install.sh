#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${1:-all}"

link_item() {
	local src="$1"
	local dest="$2"
	mkdir -p "$(dirname "$dest")"
	rm -rf "$dest"
	ln -sf "$src" "$dest"
	echo "Linked: $dest"
}

copy_item() {
	local src="$1"
	local dest="$2"
	mkdir -p "$(dirname "$dest")"
	if [ -e "$dest" ] && [ ! -L "$dest" ]; then
		backup_existing_file "$dest"
	fi
	rm -rf "$dest"
	cp -p "$src" "$dest"
	echo "Copied: $dest"
}

backup_existing_file() {
	local file="$1"
	if [ -e "$file" ] && [ ! -L "$file" ]; then
		local backup="$file.backup.$(date +%Y%m%d%H%M%S)"
		cp -p "$file" "$backup"
		echo "Backed up: $backup"
	fi
}

install_shared_bin() {
	mkdir -p "$HOME/.local/bin"
	link_item "$SCRIPT_DIR/bin/blueprint" "$HOME/.local/bin/blueprint"
}

install_context_guard_core() {
	local crate="$SCRIPT_DIR/crates/context-guard/Cargo.toml"
	local binary="$SCRIPT_DIR/target/release/context-guard"

	if [ ! -f "$crate" ]; then
		echo "Error: missing vendored Context Guard crate at $crate" >&2
		exit 1
	fi
	if ! command -v cargo >/dev/null 2>&1; then
		echo "Error: cargo is required to build Context Guard for Pi." >&2
		exit 1
	fi

	echo "Building Context Guard core..."
	(cd "$SCRIPT_DIR" && cargo build --release -p context-guard)
	mkdir -p "$HOME/.local/bin"
	link_item "$binary" "$HOME/.local/bin/context-guard"
}

install_node_dependencies() {
	if [ ! -f "$SCRIPT_DIR/package.json" ]; then
		return
	fi

	echo "Installing node dependencies..."
	if command -v bun >/dev/null 2>&1; then
		(cd "$SCRIPT_DIR" && bun install)
	elif command -v npm >/dev/null 2>&1; then
		(cd "$SCRIPT_DIR" && npm install --no-package-lock)
	else
		echo "Error: bun or npm is required to install node dependencies." >&2
		exit 1
	fi
}

ensure_pi_dependencies() {
	if node -e '
const { readFileSync } = require("fs");
const { createRequire } = require("module");
const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
const requireFromPi = createRequire(process.argv[2]);
const missing = [];

for (const moduleName of Object.keys(pkg.dependencies ?? {})) {
	try {
		requireFromPi.resolve(moduleName);
	} catch (error) {
		if (error && error.code === "MODULE_NOT_FOUND") {
			missing.push(moduleName);
		}
	}
}

if (missing.length > 0) {
	console.error(`Missing node dependencies: ${missing.join(", ")}`);
	process.exit(1);
}
' "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/harnesses/pi/extensions/fileops/index.ts" >/dev/null 2>&1; then
		return
	fi

	install_node_dependencies
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
	ensure_pi_dependencies
	if [ -d "$SCRIPT_DIR/node_modules" ]; then
		link_item "$SCRIPT_DIR/node_modules" "$dir/node_modules"
	fi
	for config in keybindings.json tui.json effort.json; do
		if [ -f "$SCRIPT_DIR/harnesses/pi/$config" ]; then
			link_item "$SCRIPT_DIR/harnesses/pi/$config" "$dir/$config"
		fi
	done

	mkdir -p "$dir/extensions"
	rm -rf "$dir/extensions/apply-patch"
	for extension in "$SCRIPT_DIR/harnesses/pi/extensions/"*; do
		[ -e "$extension" ] || continue
		link_item "$extension" "$dir/extensions/$(basename "$extension")"
	done
	install_context_guard_core
}

install_codex() {
	local dir="${CODEX_CONFIG_DIR:-$HOME/.codex}"
	local agents_dir="${CODEX_AGENTS_DIR:-$HOME/.agents}"
	mkdir -p "$dir"
	mkdir -p "$agents_dir"

	copy_item "$SCRIPT_DIR/harnesses/codex/config.toml" "$dir/config.toml"
	if [ -f "$SCRIPT_DIR/harnesses/codex/hooks.json" ]; then
		link_item "$SCRIPT_DIR/harnesses/codex/hooks.json" "$dir/hooks.json"
	fi
	if [ -d "$SCRIPT_DIR/harnesses/codex/hooks" ]; then
		mkdir -p "$dir/hooks"
		for hook in "$SCRIPT_DIR/harnesses/codex/hooks/"*; do
			[ -f "$hook" ] || continue
			link_item "$hook" "$dir/hooks/$(basename "$hook")"
		done
	fi
	link_item "$SCRIPT_DIR/AGENTS.md" "$dir/AGENTS.md"
	link_item "$SCRIPT_DIR/rules" "$dir/rules-md"
	link_item "$SCRIPT_DIR/skills" "$agents_dir/skills"
	link_item "$SCRIPT_DIR/rules" "$agents_dir/rules"
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
codex)
	install_codex
	install_shared_bin
	;;
all)
	install_claude
	install_pi
	install_codex
	install_shared_bin
	;;
*)
	echo "Usage: $0 [claude|pi|codex|all]" >&2
	exit 1
	;;
esac

echo "Done"
