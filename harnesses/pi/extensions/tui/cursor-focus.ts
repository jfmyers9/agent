import { type FSWatcher, watch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const ENABLE_FOCUS_EVENTS = "\x1b[?1004h";
const DISABLE_FOCUS_EVENTS = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const SHOW_CURSOR = "\x1b[?25h";
const TMUX_PANE = process.env.TMUX_PANE;
const HOOK_ID = process.pid;
const STATE_DIR = join(tmpdir(), "agents-pi-tmux-focus-cursor");
const STATE_FILE = TMUX_PANE
	? join(STATE_DIR, `pane-${TMUX_PANE.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${HOOK_ID}.state`)
	: undefined;
const TMUX_TIMEOUT_MS = 500;

function write(tui: TUI, data: string): void {
	tui.terminal.write(data);
}

function applyFocusedCursor(tui: TUI): void {
	tui.setShowHardwareCursor(true);
}

function applyBlurredCursor(tui: TUI): void {
	tui.setShowHardwareCursor(false);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function hookCommand(value: "0" | "1"): string {
	return `run-shell -b "printf %s ${value} > ${shellQuote(STATE_FILE!)}"`;
}

export function installFocusCursor(pi: ExtensionAPI, ctx: ExtensionContext, tui: TUI): () => void {
	if (!ctx.hasUI) return () => {};

	let stateWatcher: FSWatcher | undefined;
	let tmuxHooksInstalled = false;
	let focused = true;

	const runTmux = async (args: string[]) => {
		await pi.exec("tmux", args, { timeout: TMUX_TIMEOUT_MS });
	};

	const applyFocus = (nextFocused: boolean) => {
		if (focused === nextFocused) return;
		focused = nextFocused;
		if (focused) applyFocusedCursor(tui);
		else applyBlurredCursor(tui);
		tui.requestRender();
	};

	const applyStateFromFile = async () => {
		if (!STATE_FILE) return;
		try {
			applyFocus((await readFile(STATE_FILE, "utf8")).trim() !== "0");
		} catch {}
	};

	const installTmuxHooks = async () => {
		if (!TMUX_PANE || !STATE_FILE || tmuxHooksInstalled) return;
		await mkdir(STATE_DIR, { recursive: true });
		await writeFile(STATE_FILE, focused ? "1" : "0");
		await runTmux(["set-hook", "-p", "-t", TMUX_PANE, `pane-focus-in[${HOOK_ID}]`, hookCommand("1")]);
		await runTmux(["set-hook", "-p", "-t", TMUX_PANE, `pane-focus-out[${HOOK_ID}]`, hookCommand("0")]);
		tmuxHooksInstalled = true;
		stateWatcher = watch(STATE_FILE, { persistent: false }, () => {
			void applyStateFromFile();
		});
		stateWatcher.on("error", () => {
			stateWatcher?.close();
			stateWatcher = undefined;
		});
		await applyStateFromFile();
	};

	const uninstallTmuxHooks = async () => {
		stateWatcher?.close();
		stateWatcher = undefined;
		if (TMUX_PANE && tmuxHooksInstalled) {
			await Promise.allSettled([
				runTmux(["set-hook", "-up", "-t", TMUX_PANE, `pane-focus-in[${HOOK_ID}]`]),
				runTmux(["set-hook", "-up", "-t", TMUX_PANE, `pane-focus-out[${HOOK_ID}]`]),
			]);
			tmuxHooksInstalled = false;
		}
		if (STATE_FILE) await rm(STATE_FILE, { force: true });
	};

	write(tui, ENABLE_FOCUS_EVENTS);
	applyFocusedCursor(tui);
	void installTmuxHooks();

	const unsubscribe = ctx.ui.onTerminalInput((data) => {
		const focused = data.includes(FOCUS_IN);
		const blurred = data.includes(FOCUS_OUT);
		if (!focused && !blurred) return undefined;

		if (blurred) applyFocus(false);
		if (focused) applyFocus(true);

		const rest = data.replaceAll(FOCUS_IN, "").replaceAll(FOCUS_OUT, "");
		return rest ? { data: rest } : { consume: true };
	});

	return () => {
		unsubscribe();
		void uninstallTmuxHooks();
		tui.setShowHardwareCursor(true);
		write(tui, DISABLE_FOCUS_EVENTS + SHOW_CURSOR);
	};
}
