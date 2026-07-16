import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __pkg_dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORE_TIMEOUT_MS = 10 * 60_000;
const MAX_CORE_TIMEOUT_MS = 24 * 60 * 60_000;
const CORE_TIMEOUT_GRACE_MS = 1_000;
const SYNC_CORE_TIMEOUT_MS = 2_000;
const MAX_CORE_OUTPUT_BYTES = 8 * 1024 * 1024;

export type PiToolResponse = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

export type CoreResponse = PiToolResponse & {
	ok?: boolean;
	isError?: boolean;
};

function executableNames(name: string): string[] {
	return process.platform === "win32" ? [name, `${name}.exe`] : [name];
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveCoreBin(): string | null {
	const bin = process.env.CONTEXT_GUARD_BIN?.trim();
	if (bin && isExecutableFile(bin)) return bin;

	if (process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN !== "1") {
		for (const name of executableNames("context-guard")) {
			for (const rel of [`../../../../../target/release/${name}`, `../../../../../target/debug/${name}`]) {
				const candidate = resolve(__pkg_dir, rel);
				if (isExecutableFile(candidate)) return candidate;
			}
		}
	}

	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of executableNames("context-guard")) {
			const candidate = resolve(dir, name);
			if (isExecutableFile(candidate)) return candidate;
		}
	}

	return null;
}

export function buildCoreCheckText(): string {
	const envBin = process.env.CONTEXT_GUARD_BIN?.trim();
	const resolved = resolveCoreBin();
	const lines = ["context-guard check"];
	lines.push("");
	if (resolved) {
		lines.push(`[OK] Core binary: ${resolved}`);
		if (envBin && resolved === envBin) lines.push("[OK] CONTEXT_GUARD_BIN is set");
		else if (envBin) lines.push(`[WARN] Ignoring invalid CONTEXT_GUARD_BIN: ${envBin}`);
		return lines.join("\n");
	}
	lines.push("[FAIL] Core binary: not found");
	lines.push(`[${envBin ? "FAIL" : "WARN"}] CONTEXT_GUARD_BIN: ${envBin || "not set"}`);
	lines.push("");
	lines.push("Context Guard tools are registered but unavailable until a context-guard binary is installed.");
	lines.push(
		"Install/build the core separately and set CONTEXT_GUARD_BIN=/path/to/context-guard, or remove extensions/context-guard/index.ts from Pi settings.",
	);
	return lines.join("\n");
}

export function missingCoreMessage(): string {
	return buildCoreCheckText();
}

function missingCoreResponse(): CoreResponse {
	return {
		content: [
			{
				type: "text",
				text: missingCoreMessage(),
			},
		],
		isError: true,
	};
}

interface ProcessInfo {
	pid: number;
	ppid: number;
	pgid: number;
}

function listProcesses(): ProcessInfo[] {
	if (process.platform === "win32") return [];
	try {
		return execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], {
			encoding: "utf8",
			timeout: 1_000,
			maxBuffer: 4 * 1024 * 1024,
		})
			.split("\n")
			.map((line): ProcessInfo | undefined => {
				const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
				if (!match) return undefined;
				return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) };
			})
			.filter((entry): entry is ProcessInfo => entry !== undefined);
	} catch {
		return [];
	}
}

function collectProcessTree(rootPid: number): { pids: number[]; pgids: number[] } {
	const processes = listProcesses();
	const childrenByParent = new Map<number, ProcessInfo[]>();
	for (const entry of processes) {
		const children = childrenByParent.get(entry.ppid) ?? [];
		children.push(entry);
		childrenByParent.set(entry.ppid, children);
	}

	const descendants: ProcessInfo[] = [];
	const pending = [...(childrenByParent.get(rootPid) ?? [])];
	while (pending.length > 0) {
		const entry = pending.pop();
		if (!entry) continue;
		descendants.push(entry);
		pending.push(...(childrenByParent.get(entry.pid) ?? []));
	}

	return {
		pids: descendants.map((entry) => entry.pid).reverse(),
		pgids: [...new Set([rootPid, ...descendants.map((entry) => entry.pgid)])].filter((pgid) => pgid > 0),
	};
}

function killPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process already exited or is not signalable by this user.
	}
}

function terminateProcessTree(childPid: number | undefined): void {
	if (childPid === undefined || childPid <= 0) return;
	if (process.platform === "win32") {
		try {
			execFileSync("taskkill", ["/PID", String(childPid), "/T", "/F"], {
				stdio: "ignore",
				timeout: 2_000,
			});
		} catch {
			killPid(childPid, "SIGKILL");
		}
		return;
	}

	const { pids, pgids } = collectProcessTree(childPid);
	for (const pid of [...pids, childPid]) killPid(pid, "SIGTERM");
	for (const pgid of pgids) killPid(-pgid, "SIGTERM");
	setTimeout(() => {
		for (const pid of [...pids, childPid]) killPid(pid, "SIGKILL");
		for (const pgid of pgids) killPid(-pgid, "SIGKILL");
	}, 500).unref?.();
}

function coreWatchdogTimeout(params: Record<string, unknown>): number {
	const requested = params.timeout;
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) {
		return DEFAULT_CORE_TIMEOUT_MS;
	}
	return Math.min(MAX_CORE_TIMEOUT_MS, requested + CORE_TIMEOUT_GRACE_MS);
}

export async function invokeCore(
	command: string,
	params: Record<string, unknown> = {},
	signal?: AbortSignal,
): Promise<CoreResponse> {
	const bin = resolveCoreBin();
	if (!bin) {
		return missingCoreResponse();
	}

	if (signal?.aborted) {
		return {
			content: [{ type: "text", text: "Context Guard core cancelled" }],
			isError: true,
		};
	}

	return new Promise((resolvePromise) => {
		const child = spawn(bin, [], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let cancelled = false;
		let outputBytes = 0;
		const watchdogTimeout = coreWatchdogTimeout(params);
		let watchdog: ReturnType<typeof setTimeout> | undefined;

		const settle = (response: CoreResponse) => {
			if (settled) return;
			settled = true;
			if (watchdog) clearTimeout(watchdog);
			signal?.removeEventListener("abort", abortListener);
			resolvePromise(response);
		};
		const abortListener = () => {
			cancelled = true;
			terminateProcessTree(child.pid);
			settle({
				content: [{ type: "text", text: "Context Guard core cancelled" }],
				isError: true,
			});
		};
		const appendOutput = (stream: "stdout" | "stderr", chunk: string) => {
			if (settled) return;
			outputBytes += Buffer.byteLength(chunk);
			if (outputBytes > MAX_CORE_OUTPUT_BYTES) {
				terminateProcessTree(child.pid);
				settle({
					content: [
						{
							type: "text",
							text: `Context Guard core output exceeded ${MAX_CORE_OUTPUT_BYTES} bytes`,
						},
					],
					isError: true,
				});
				return;
			}
			if (stream === "stdout") stdout += chunk;
			else stderr += chunk;
		};

		signal?.addEventListener("abort", abortListener, { once: true });
		watchdog = setTimeout(() => {
			terminateProcessTree(child.pid);
			settle({
				content: [{ type: "text", text: `Context Guard core timed out after ${watchdogTimeout}ms` }],
				isError: true,
			});
		}, watchdogTimeout);
		watchdog.unref?.();

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			appendOutput("stdout", chunk);
		});
		child.stderr.on("data", (chunk) => {
			appendOutput("stderr", chunk);
		});
		child.on("error", (err) => {
			settle({
				content: [{ type: "text", text: `Context Guard core error: ${err.message}` }],
				isError: true,
			});
		});
		child.on("close", (code) => {
			if (cancelled || signal?.aborted) {
				settle({
					content: [{ type: "text", text: "Context Guard core cancelled" }],
					isError: true,
				});
				return;
			}
			if (code !== 0) {
				settle({
					content: [{ type: "text", text: `Context Guard core exited ${code}: ${stderr.trim()}`.trim() }],
					isError: true,
				});
				return;
			}

			try {
				settle(JSON.parse(stdout) as CoreResponse);
			} catch (err) {
				settle({
					content: [
						{
							type: "text",
							text: `Context Guard core returned invalid JSON: ${err instanceof Error ? err.message : err}`,
						},
					],
					isError: true,
				});
			}
		});

		child.stdin.end(JSON.stringify({ command, params }));
	});
}

export function invokeCoreSync(command: string, params: Record<string, unknown> = {}): CoreResponse {
	const bin = resolveCoreBin();
	if (!bin) {
		return missingCoreResponse();
	}

	const result = spawnSync(bin, [], {
		input: JSON.stringify({ command, params }),
		encoding: "utf8",
		timeout: SYNC_CORE_TIMEOUT_MS,
		killSignal: "SIGKILL",
		maxBuffer: MAX_CORE_OUTPUT_BYTES,
	});

	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ETIMEDOUT") {
			return {
				content: [{ type: "text", text: `Context Guard core timed out after ${SYNC_CORE_TIMEOUT_MS}ms` }],
				isError: true,
			};
		}
		if (code === "ENOBUFS") {
			return {
				content: [{ type: "text", text: `Context Guard core output exceeded ${MAX_CORE_OUTPUT_BYTES} bytes` }],
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: `Context Guard core error: ${result.error.message}` }],
			isError: true,
		};
	}

	if (result.status !== 0) {
		return {
			content: [
				{
					type: "text",
					text: `Context Guard core exited ${result.status}: ${(result.stderr ?? "").trim()}`.trim(),
				},
			],
			isError: true,
		};
	}

	try {
		return JSON.parse(result.stdout ?? "") as CoreResponse;
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `Context Guard core returned invalid JSON: ${err instanceof Error ? err.message : err}`,
				},
			],
			isError: true,
		};
	}
}

export function parseCoreJson<T>(response: CoreResponse): T | null {
	if (response.isError) return null;
	const text = response.content[0]?.text;
	if (!text) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}
