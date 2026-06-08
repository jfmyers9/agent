import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type MuxPiState = {
	version: 1;
	agent: "pi";
	paneId: string;
	pid: number;
	cwd: string;
	updatedAtMs: number;
	lastActivityAtMs: number;
	activity?: string;
	asking: boolean;
	[key: string]: unknown;
};

function stateDir(): string {
	const base = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state");
	return join(base, "mux", "pi-agents");
}

function statePath(): string | undefined {
	const pane = process.env.TMUX_PANE;
	if (!pane) return undefined;
	return join(stateDir(), `${pane.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function syncSidebar() {
	const child = spawn("mux", ["sidebar", "sync"], {
		stdio: "ignore",
		detached: true,
	});
	child.on("error", () => {});
	child.unref();
}

export function updateMuxAskState(next: { activity?: string; asking: boolean }, cwd: string) {
	const file = statePath();
	const pane = process.env.TMUX_PANE;
	if (!(file && pane)) return;

	const now = Date.now();
	let previous: Partial<MuxPiState> = {};
	try {
		previous = JSON.parse(readFileSync(file, "utf-8"));
	} catch {}

	const snapshot: MuxPiState = {
		...previous,
		version: 1,
		agent: "pi",
		paneId: pane,
		pid: process.pid,
		cwd,
		updatedAtMs: now,
		lastActivityAtMs: now,
		activity: next.activity,
		asking: next.asking,
	};
	if (!next.activity) {
		delete snapshot.activity;
	}

	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(file, `${JSON.stringify(snapshot)}\n`, "utf-8");
	syncSidebar();
}
