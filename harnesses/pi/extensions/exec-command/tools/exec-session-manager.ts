// @ts-nocheck
import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import * as pty from "node-pty";
import { DEFAULT_EXEC_SHELL, isFishShell, resolveRuntimeShell } from "../adapter/runtime-shell.ts";
import {
	approxTokenCount,
	capHeadTail,
	formattedTruncateText,
	UNIFIED_EXEC_OUTPUT_MAX_BYTES,
} from "./output-truncation.ts";

type ExecTerminalState = "exited" | "timed_out" | "cancelled" | "session_error";
type ExecInterventionState = "timed_out" | "cancelled";

export interface UnifiedExecResult {
	chunk_id: string;
	wall_time_seconds: number;
	output: string;
	exit_code?: number;
	terminal_state?: ExecTerminalState;
	timed_out?: boolean;
	cancelled?: boolean;
	session_error?: string;
	process_id?: number;
	stdin_open?: boolean;
	original_token_count?: number;
	output_truncated?: boolean;
}

export interface ExecSessionSnapshot {
	command: string;
	output: string;
	running: boolean;
	exitCode?: number;
	terminalState?: ExecTerminalState;
	timedOut?: boolean;
	cancelled?: boolean;
	sessionError?: string;
	stdinOpen?: boolean;
	elapsedMs: number;
	originalTokenCount?: number;
	outputTruncated: boolean;
}

export interface ExecSessionRecord {
	id: number;
	command: string;
	output: string;
	running: boolean;
	exitCode?: number;
	stdinOpen: boolean;
	startedAtMs: number;
}

export interface ExecCommandInput {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	timeout?: number;
	login?: boolean;
}

export interface WriteStdinInput {
	process_id: number;
	chars?: string;
	yield_time_ms?: number;
}

export type ExecSessionUpdateCallback = (result: UnifiedExecResult) => void;

interface BaseExecSession {
	id: number;
	command: string;
	buffer: string;
	pendingBuffer: string;
	emittedBuffer: string;
	exitCode: number | null | undefined;
	terminalState: ExecTerminalState | undefined;
	pendingTerminalState: ExecInterventionState | undefined;
	sessionError: string | undefined;
	finalized: boolean;
	listeners: Set<() => void>;
	interactive: boolean;
	startedAtMs: number;
	hidden: boolean;
}

interface PipeExecSession extends BaseExecSession {
	kind: "pipe";
	child: ChildProcessByStdio<null, Readable, Readable>;
}

interface PtyExecSession extends BaseExecSession {
	kind: "pty";
	child: pty.IPty;
	terminalCommitted: string;
	terminalLine: string[];
	terminalCursor: number;
	terminalStyle: string;
	terminalPendingEscape: string;
}

type ExecSession = PipeExecSession | PtyExecSession;

export interface ExecSessionManager {
	exec(
		input: ExecCommandInput,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: ExecSessionUpdateCallback,
	): Promise<UnifiedExecResult>;
	write(input: WriteStdinInput): Promise<UnifiedExecResult>;
	hasSession(sessionId: number): boolean;
	getSessionCommand(sessionId: number): string | undefined;
	getSessionSnapshot(sessionId: number): ExecSessionSnapshot | undefined;
	listSessions(): ExecSessionRecord[];
	stopSession(sessionId: number): boolean;
	stopAllSessions(): number;
	onSessionExit(listener: (sessionId: number, command: string) => void): () => void;
	onSessionUpdate(listener: () => void): () => void;
	shutdown(): void;
}

export interface ExecSessionManagerOptions {
	defaultExecYieldTimeMs?: number;
	defaultWriteYieldTimeMs?: number;
	minNonInteractiveExecYieldTimeMs?: number;
	minEmptyWriteYieldTimeMs?: number;
	maxSessionBufferChars?: number;
}

const DEFAULT_EXEC_YIELD_TIME_MS = 120_000;
const DEFAULT_WRITE_YIELD_TIME_MS = 250;
const MIN_YIELD_TIME_MS = 250;
const MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS = 120_000;
const MIN_EMPTY_WRITE_YIELD_TIME_MS = 30_000;
const MAX_YIELD_TIME_MS = 120_000;
const MAX_COMMAND_HISTORY = 256;
const DEFAULT_MAX_SESSION_BUFFER_CHARS = UNIFIED_EXEC_OUTPUT_MAX_BYTES;
const IS_BUN_RUNTIME = typeof process !== "undefined" && typeof process.versions?.bun === "string";

function resolveWorkdir(baseCwd: string, workdir?: string): string {
	if (!workdir) return baseCwd;
	return resolve(baseCwd, workdir);
}

function resolveShell(shell?: string): string {
	return resolveRuntimeShell(shell || process.env.SHELL);
}

const BASH_SYNC_ENV_KEYS = [
	"PATH",
	"SHELL",
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"BUN_INSTALL",
	"PNPM_HOME",
	"MISE_DATA_DIR",
	"MISE_CONFIG_DIR",
	"MISE_SHIMS_DIR",
	"CARGO_HOME",
	"GOPATH",
	"ANDROID_HOME",
	"ANDROID_NDK_HOME",
	"JAVA_HOME",
];

function shellEscape(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shouldSyncFallbackShellEnv(requestedShell: string | undefined, effectiveShell: string): boolean {
	return effectiveShell === DEFAULT_EXEC_SHELL && isFishShell(requestedShell || process.env.SHELL);
}

function buildSyncedFallbackShellCommand(command: string, env: NodeJS.ProcessEnv): string {
	const assignments: string[] = [];
	for (const key of BASH_SYNC_ENV_KEYS) {
		const value = key === "SHELL" ? DEFAULT_EXEC_SHELL : env[key];
		if (typeof value !== "string") continue;
		assignments.push(`export ${key}=${shellEscape(value)}`);
	}
	if (assignments.length === 0) return command;
	return `${assignments.join("; ")}; ${command}`;
}

function resolveExecution(
	requestedShell: string | undefined,
	command: string,
): { shell: string; command: string; env: NodeJS.ProcessEnv } {
	const shell = resolveShell(requestedShell);
	const env = withUnifiedExecEnvironment({ ...process.env });
	if (!shouldSyncFallbackShellEnv(requestedShell, shell)) {
		return { shell, command, env };
	}
	env.SHELL = DEFAULT_EXEC_SHELL;
	return {
		shell,
		command: buildSyncedFallbackShellCommand(command, env),
		env,
	};
}

function withUnifiedExecEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	Object.assign(env, {
		NO_COLOR: "1",
		TERM: "dumb",
		LANG: "C.UTF-8",
		LC_CTYPE: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		COLORTERM: "",
		PAGER: "cat",
		GIT_PAGER: "cat",
		GH_PAGER: "cat",
		CODEX_CI: "1",
	});
	delete env.FORCE_COLOR;
	delete env.CLICOLOR;
	return env;
}

function clampYieldTime(yieldTimeMs: number | undefined, fallback: number): number {
	const value = yieldTimeMs ?? fallback;
	return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, value));
}

function clampExecYieldTime(
	yieldTimeMs: number | undefined,
	fallback: number,
	isInteractive: boolean,
	minNonInteractiveExecYieldTimeMs: number,
): number {
	const value = clampYieldTime(yieldTimeMs, fallback);
	if (isInteractive || yieldTimeMs !== undefined) {
		return value;
	}
	return Math.min(MAX_YIELD_TIME_MS, Math.max(minNonInteractiveExecYieldTimeMs, value));
}

function clampWriteYieldTime(
	yieldTimeMs: number | undefined,
	fallback: number,
	isEmptyPoll: boolean,
	minEmptyWriteYieldTimeMs: number,
): number {
	const value = clampYieldTime(yieldTimeMs, fallback);
	if (!isEmptyPoll || yieldTimeMs !== undefined) {
		return value;
	}
	return Math.min(MAX_YIELD_TIME_MS, Math.max(minEmptyWriteYieldTimeMs, value));
}

function stripTerminalControlSequences(text: string, preserveCsi = false, preserveSgr = false): string {
	const withoutOscAndDcs = text
		.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B[P_X^][\s\S]*?\u001B\\/g, "");
	if (preserveCsi) {
		return withoutOscAndDcs;
	}
	return withoutOscAndDcs
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, (sequence) => (preserveSgr && sequence.endsWith("m") ? sequence : ""))
		.replace(preserveSgr ? /\u001B(?!\[)[@-_]/g : /\u001B[@-_]/g, "");
}

function sanitizeBinaryOutput(text: string, preserveBackspace = false, preserveSgr = false): string {
	let output = "";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (preserveSgr && char === "\u001b" && text[index + 1] === "[") {
			let sequenceEnd = index + 2;
			while (sequenceEnd < text.length) {
				const code = text.charCodeAt(sequenceEnd);
				if (code >= 0x40 && code <= 0x7e) break;
				sequenceEnd += 1;
			}
			if (sequenceEnd < text.length && text[sequenceEnd] === "m") {
				output += text.slice(index, sequenceEnd + 1);
				index = sequenceEnd;
			}
			continue;
		}

		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code === 0x09 || code === 0x0a || code === 0x0d) {
			output += char;
			continue;
		}
		if (preserveBackspace && code === 0x08) {
			output += char;
			continue;
		}
		if (code <= 0x1f) continue;
		if (code >= 0xfff9 && code <= 0xfffb) continue;
		output += char;
	}
	return output;
}

function normalizePipeOutput(text: string): string {
	return sanitizeBinaryOutput(stripTerminalControlSequences(text, false, true), false, true)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

function writeTerminalChar(session: PtyExecSession, char: string): void {
	if (session.terminalCursor > session.terminalLine.length) {
		session.terminalLine.push(
			...Array.from({ length: session.terminalCursor - session.terminalLine.length }, () => " "),
		);
	}
	session.terminalLine[session.terminalCursor] = session.terminalStyle
		? `${session.terminalStyle}${char}\u001b[0m`
		: char;
	session.terminalCursor += 1;
}

function applyTerminalOutput(session: PtyExecSession, text: string): string {
	const sanitized = session.terminalPendingEscape + stripTerminalControlSequences(text, true);
	session.terminalPendingEscape = "";
	if (sanitized.length === 0) {
		return session.terminalCommitted + session.terminalLine.join("");
	}

	for (let index = 0; index < sanitized.length; index += 1) {
		const char = sanitized[index]!;
		if (char === "\u001b") {
			if (sanitized[index + 1] === "[") {
				let sequenceEnd = index + 2;
				while (sequenceEnd < sanitized.length) {
					const code = sanitized.charCodeAt(sequenceEnd);
					if (code >= 0x40 && code <= 0x7e) {
						break;
					}
					sequenceEnd += 1;
				}
				if (sequenceEnd >= sanitized.length) {
					session.terminalPendingEscape = sanitized.slice(index);
					break;
				}
				const params = sanitized.slice(index + 2, sequenceEnd);
				const finalByte = sanitized[sequenceEnd];
				if (finalByte === "m") {
					session.terminalStyle = params === "" || params.split(";").includes("0") ? "" : `\u001b[${params}m`;
				} else if (finalByte === "K") {
					const mode = Number(params || "0");
					if (mode === 0) {
						session.terminalLine = session.terminalLine.slice(0, session.terminalCursor);
					} else if (mode === 1) {
						session.terminalLine = [
							...Array.from(
								{
									length: Math.min(session.terminalCursor, session.terminalLine.length),
								},
								() => " ",
							),
							...session.terminalLine.slice(session.terminalCursor),
						];
					} else if (mode === 2) {
						session.terminalLine = [];
					}
				}
				index = sequenceEnd;
				continue;
			}

			const next = sanitized[index + 1];
			if (next && /[()*+,\-./]/.test(next) && index + 2 < sanitized.length) {
				index += 2;
				continue;
			}
			if (!next) {
				session.terminalPendingEscape = sanitized.slice(index);
				break;
			}
			if (next) {
				index += 1;
			}
			continue;
		}

		const code = char.codePointAt(0);
		if (code !== undefined && code <= 0x1f && char !== "\t" && char !== "\n" && char !== "\r" && char !== "\b") {
			continue;
		}

		switch (char) {
			case "\r":
				session.terminalCursor = 0;
				break;
			case "\n":
				session.terminalCommitted += `${session.terminalLine.join("")}\n`;
				session.terminalLine = [];
				session.terminalCursor = 0;
				break;
			case "\b":
				session.terminalCursor = Math.max(0, session.terminalCursor - 1);
				break;
			default:
				writeTerminalChar(session, char);
				break;
		}
	}

	return session.terminalCommitted + session.terminalLine.join("");
}

function computePtyDelta(previous: string, current: string): string {
	if (current.startsWith(previous)) {
		return current.slice(previous.length);
	}

	const lineStart = previous.lastIndexOf("\n") + 1;
	const stablePrefix = previous.slice(0, lineStart);
	if (current.startsWith(stablePrefix)) {
		return `\r${current.slice(lineStart)}`;
	}

	return current;
}

function generateChunkId(): string {
	return randomBytes(3).toString("hex");
}

function consumeOutput(session: ExecSession): {
	output: string;
	original_token_count?: number;
	output_truncated?: boolean;
} {
	const text = session.pendingBuffer;
	session.pendingBuffer = "";
	session.emittedBuffer = session.buffer;
	if (text.length === 0) {
		return { output: "" };
	}

	return {
		...formattedTruncateText(text),
		original_token_count: approxTokenCount(text),
	};
}

function registerAbortHandler(signal: AbortSignal | undefined, onAbort: () => void): () => void {
	if (!signal) {
		return () => {};
	}

	if (signal.aborted) {
		onAbort();
		return () => {};
	}

	const abortListener = () => onAbort();
	signal.addEventListener("abort", abortListener, { once: true });
	return () => signal.removeEventListener("abort", abortListener);
}

interface ProcessInfo {
	pid: number;
	ppid: number;
	pgid: number;
}

function listProcesses(): ProcessInfo[] {
	try {
		return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
			encoding: "utf8",
		})
			.split("\n")
			.map((line): ProcessInfo | undefined => {
				const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+/);
				if (!match) return undefined;
				return {
					pid: Number(match[1]),
					ppid: Number(match[2]),
					pgid: Number(match[3]),
				};
			})
			.filter((process): process is ProcessInfo => process !== undefined);
	} catch {
		return [];
	}
}

function collectDescendantPids(rootPid: number): number[] {
	const childrenByParent = new Map<number, number[]>();
	for (const process of listProcesses()) {
		const children = childrenByParent.get(process.ppid) ?? [];
		children.push(process.pid);
		childrenByParent.set(process.ppid, children);
	}

	const descendants: number[] = [];
	const pending = [...(childrenByParent.get(rootPid) ?? [])];
	while (pending.length > 0) {
		const pid = pending.pop();
		if (pid === undefined) continue;
		descendants.push(pid);
		pending.push(...(childrenByParent.get(pid) ?? []));
	}
	return descendants;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process already exited or is not signalable by this user.
	}
}

function terminateProcessTree(rootPid: number | undefined, includeRootProcessGroup: boolean, force = false): void {
	if (rootPid === undefined || rootPid <= 0) return;
	const descendants = collectDescendantPids(rootPid);
	const targets = [...descendants.reverse(), rootPid];
	for (const pid of targets) {
		killPid(pid, "SIGTERM");
	}
	if (includeRootProcessGroup) {
		killPid(-rootPid, "SIGTERM");
	}

	if (force) {
		for (const pid of targets) {
			killPid(pid, "SIGKILL");
		}
		if (includeRootProcessGroup) {
			killPid(-rootPid, "SIGKILL");
		}
		return;
	}

	const killTimer = setTimeout(() => {
		for (const pid of targets) {
			killPid(pid, "SIGKILL");
		}
		if (includeRootProcessGroup) {
			killPid(-rootPid, "SIGKILL");
		}
	}, 500);
	killTimer.unref?.();
}

export function createExecSessionManager(options: ExecSessionManagerOptions = {}): ExecSessionManager {
	let nextSessionId = 1;
	const sessions = new Map<number, ExecSession>();
	const commandHistory = new Map<number, string>();
	const exitListeners = new Set<(sessionId: number, command: string) => void>();
	const updateListeners = new Set<() => void>();
	const defaultExecYieldTimeMs = options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
	const defaultWriteYieldTimeMs = options.defaultWriteYieldTimeMs ?? DEFAULT_WRITE_YIELD_TIME_MS;
	const minNonInteractiveExecYieldTimeMs = Math.min(
		MAX_YIELD_TIME_MS,
		Math.max(MIN_YIELD_TIME_MS, options.minNonInteractiveExecYieldTimeMs ?? MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS),
	);
	const minEmptyWriteYieldTimeMs = Math.min(
		MAX_YIELD_TIME_MS,
		Math.max(MIN_YIELD_TIME_MS, options.minEmptyWriteYieldTimeMs ?? MIN_EMPTY_WRITE_YIELD_TIME_MS),
	);
	const maxSessionBufferChars = Math.max(1024, options.maxSessionBufferChars ?? DEFAULT_MAX_SESSION_BUFFER_CHARS);

	function rememberCommand(sessionId: number, command: string): void {
		commandHistory.set(sessionId, command);
		if (commandHistory.size <= MAX_COMMAND_HISTORY) {
			return;
		}
		const oldest = commandHistory.keys().next().value;
		if (oldest !== undefined) {
			commandHistory.delete(oldest);
		}
	}

	function notify(session: ExecSession): void {
		for (const listener of session.listeners) {
			listener();
		}
		notifySessionUpdate();
	}

	function notifySessionUpdate(): void {
		for (const listener of updateListeners) {
			listener();
		}
	}

	function isRunning(session: ExecSession): boolean {
		return session.terminalState === undefined;
	}

	function toRecord(session: ExecSession): ExecSessionRecord {
		const running = isRunning(session);
		return {
			id: session.id,
			command: session.command,
			output: session.buffer,
			running,
			exitCode: session.terminalState === "exited" ? (session.exitCode ?? 0) : undefined,
			stdinOpen: session.interactive,
			startedAtMs: session.startedAtMs,
		};
	}

	function deleteSession(sessionId: number): boolean {
		const deleted = sessions.delete(sessionId);
		if (deleted) {
			notifySessionUpdate();
		}
		return deleted;
	}

	function deleteExitedSessions(): void {
		for (const [sessionId, session] of sessions) {
			if (!isRunning(session)) sessions.delete(sessionId);
		}
	}

	function terminateSession(session: ExecSession, reason: ExecInterventionState = "cancelled"): void {
		if (!isRunning(session)) return;
		session.pendingTerminalState = reason;
		if (session.kind === "pty") {
			terminateProcessTree(session.child.pid, false, true);
		} else {
			terminateProcessTree(session.child.pid, true, true);
		}
	}

	function finalizeSession(session: ExecSession): void {
		if (session.finalized) return;
		session.finalized = true;
		for (const listener of exitListeners) {
			listener(session.id, session.command);
		}
		if (session.hidden) sessions.delete(session.id);
		notify(session);
	}

	function completeSession(
		session: ExecSession,
		terminalState: ExecTerminalState,
		exitCode?: number,
		sessionError?: string,
	): void {
		if (session.terminalState !== undefined) return;
		session.terminalState = terminalState;
		session.exitCode = terminalState === "exited" ? (exitCode ?? 0) : undefined;
		session.sessionError = sessionError;
		finalizeSession(session);
	}

	function addTerminalState(result: UnifiedExecResult, session: ExecSession): void {
		if (session.terminalState === undefined) return;
		result.terminal_state = session.terminalState;
		if (session.terminalState === "exited") result.exit_code = session.exitCode ?? 0;
		if (session.terminalState === "timed_out") result.timed_out = true;
		if (session.terminalState === "cancelled") result.cancelled = true;
		if (session.terminalState === "session_error" && session.sessionError) {
			result.session_error = session.sessionError;
		}
	}

	function appendOutput(session: ExecSession, text: string): void {
		if (text.length === 0) return;
		const previous = session.buffer;
		if (session.kind === "pty") {
			session.buffer = applyTerminalOutput(session, text);
			session.pendingBuffer = capHeadTail(
				`${session.pendingBuffer}${computePtyDelta(previous, session.buffer)}`,
				UNIFIED_EXEC_OUTPUT_MAX_BYTES,
			);
		} else {
			const normalized = normalizePipeOutput(text);
			session.buffer = `${session.buffer}${normalized}`;
			session.pendingBuffer = capHeadTail(`${session.pendingBuffer}${normalized}`, UNIFIED_EXEC_OUTPUT_MAX_BYTES);
		}
		if (session.buffer.length > maxSessionBufferChars) {
			session.buffer = capHeadTail(session.buffer, maxSessionBufferChars);
			session.emittedBuffer = "";
		}
		notify(session);
	}

	function waitForExitOrTimeout(session: ExecSession, yieldTimeMs: number): Promise<number> {
		if (!isRunning(session)) {
			return Promise.resolve(0);
		}

		const startedAt = Date.now();
		return new Promise((resolvePromise) => {
			const onWake = () => {
				if (isRunning(session)) {
					return;
				}
				cleanup();
				resolvePromise(Date.now() - startedAt);
			};
			const timeout = setTimeout(() => {
				cleanup();
				resolvePromise(Date.now() - startedAt);
			}, yieldTimeMs);
			const cleanup = () => {
				clearTimeout(timeout);
				session.listeners.delete(onWake);
			};
			session.listeners.add(onWake);
		});
	}

	function makeResult(session: ExecSession, waitMs: number): UnifiedExecResult {
		const consumed = consumeOutput(session);
		const result: UnifiedExecResult = {
			chunk_id: generateChunkId(),
			wall_time_seconds: waitMs / 1000,
			output: consumed.output,
		};
		if (consumed.original_token_count !== undefined) {
			result.original_token_count = consumed.original_token_count;
		}
		if (consumed.output_truncated) {
			result.output_truncated = true;
		}
		if (isRunning(session)) {
			result.process_id = session.id;
			result.stdin_open = session.interactive;
		} else {
			addTerminalState(result, session);
			if (session.emittedBuffer === session.buffer) {
				deleteSession(session.id);
			}
		}
		return result;
	}

	function makeSnapshot(session: ExecSession, startedAtMs: number): UnifiedExecResult {
		const truncated = formattedTruncateText(session.buffer);
		const result: UnifiedExecResult = {
			chunk_id: generateChunkId(),
			wall_time_seconds: (Date.now() - startedAtMs) / 1000,
			output: truncated.output,
		};
		if (truncated.output_truncated) {
			result.output_truncated = true;
			result.original_token_count = approxTokenCount(session.buffer);
		}
		if (isRunning(session)) {
			result.process_id = session.id;
			result.stdin_open = session.interactive;
		} else {
			addTerminalState(result, session);
		}
		return result;
	}

	function scheduleCommandTimeout(session: ExecSession, timeoutMs: number | undefined): void {
		if (timeoutMs === undefined || timeoutMs <= 0) return;
		const timer = setTimeout(() => terminateSession(session, "timed_out"), timeoutMs);
		timer.unref?.();
	}

	function streamSessionUpdates(
		session: ExecSession,
		onUpdate: ExecSessionUpdateCallback | undefined,
	): (() => void) | undefined {
		if (!onUpdate) return undefined;
		const startedAtMs = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;
		let lastOutput: string | undefined;
		let lastTerminalState: string | undefined;
		const emit = () => {
			timer = undefined;
			if (disposed) return;
			const snapshot = makeSnapshot(session, startedAtMs);
			if (snapshot.output === lastOutput && snapshot.terminal_state === lastTerminalState) return;
			lastOutput = snapshot.output;
			lastTerminalState = snapshot.terminal_state;
			onUpdate(snapshot);
		};
		const schedule = () => {
			if (timer || disposed) return;
			timer = setTimeout(emit, 80);
		};
		session.listeners.add(schedule);
		return () => {
			disposed = true;
			if (timer) clearTimeout(timer);
			session.listeners.delete(schedule);
		};
	}

	function createPipeSession(
		input: ExecCommandInput,
		workdir: string,
		shell: string,
		signal?: AbortSignal,
	): PipeExecSession {
		const login = input.login ?? true;
		const execution = resolveExecution(input.shell, input.cmd);
		const shellArgs = login ? ["-lc", execution.command] : ["-c", execution.command];
		const child = spawn(shell, shellArgs, {
			cwd: workdir,
			stdio: [input.tty ? "pipe" : "ignore", "pipe", "pipe"],
			env: execution.env,
			detached: true,
		});

		const session: PipeExecSession = {
			kind: "pipe",
			id: nextSessionId++,
			command: input.cmd,
			child,
			buffer: "",
			pendingBuffer: "",
			emittedBuffer: "",
			exitCode: undefined,
			terminalState: undefined,
			pendingTerminalState: undefined,
			sessionError: undefined,
			finalized: false,
			listeners: new Set(),
			interactive: Boolean(input.tty),
			startedAtMs: Date.now(),
			hidden: false,
		};

		child.stdout.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.stderr.on("data", (data: Buffer) => {
			appendOutput(session, data.toString("utf8"));
		});
		child.on("close", (code) => {
			completeSession(session, session.pendingTerminalState ?? "exited", code ?? 0);
		});
		child.on("error", (error) => {
			appendOutput(session, `${error.message}\n`);
			completeSession(session, "session_error", undefined, error.message);
		});

		registerAbortHandler(signal, () => {
			terminateSession(session, "cancelled");
		});
		scheduleCommandTimeout(session, input.timeout);

		return session;
	}

	function createPtySession(
		input: ExecCommandInput,
		workdir: string,
		shell: string,
		signal?: AbortSignal,
	): PtyExecSession {
		const login = input.login ?? true;
		const execution = resolveExecution(input.shell, input.cmd);
		const shellArgs = login ? ["-lc", execution.command] : ["-c", execution.command];
		const child = pty.spawn(shell, shellArgs, {
			cwd: workdir,
			env: execution.env,
			name: process.env.TERM || "xterm-256color",
			cols: 80,
			rows: 24,
		});

		const session: PtyExecSession = {
			kind: "pty",
			id: nextSessionId++,
			command: input.cmd,
			child,
			buffer: "",
			pendingBuffer: "",
			emittedBuffer: "",
			exitCode: undefined,
			terminalState: undefined,
			pendingTerminalState: undefined,
			sessionError: undefined,
			finalized: false,
			listeners: new Set(),
			interactive: true,
			startedAtMs: Date.now(),
			hidden: false,
			terminalCommitted: "",
			terminalLine: [],
			terminalCursor: 0,
			terminalStyle: "",
			terminalPendingEscape: "",
		};

		child.onData((data) => {
			appendOutput(session, data);
		});
		child.onExit(({ exitCode }) => {
			completeSession(session, session.pendingTerminalState ?? "exited", exitCode ?? 0);
		});

		registerAbortHandler(signal, () => {
			terminateSession(session, "cancelled");
		});
		scheduleCommandTimeout(session, input.timeout);

		return session;
	}

	return {
		exec: async (input, cwd, signal, onUpdate) => {
			const shell = resolveShell(input.shell);
			const workdir = resolveWorkdir(cwd, input.workdir);
			const session = input.tty
				? (() => {
						// Bun's node-pty bridge drops stdin-waiting shells immediately with SIGHUP,
						// which breaks the tty=true contract for write_stdin in tests and local tools.
						if (IS_BUN_RUNTIME) {
							return createPipeSession(input, workdir, shell, signal);
						}
						try {
							return createPtySession(input, workdir, shell, signal);
						} catch {
							return createPipeSession(input, workdir, shell, signal);
						}
					})()
				: createPipeSession(input, workdir, shell, signal);
			deleteExitedSessions();
			sessions.set(session.id, session);
			rememberCommand(session.id, session.command);
			notifySessionUpdate();
			const stopStreaming = streamSessionUpdates(session, onUpdate);

			try {
				const waitedMs = await waitForExitOrTimeout(
					session,
					clampExecYieldTime(
						input.yield_time_ms,
						defaultExecYieldTimeMs,
						session.interactive,
						minNonInteractiveExecYieldTimeMs,
					),
				);
				return makeResult(session, waitedMs);
			} finally {
				stopStreaming?.();
			}
		},
		write: async (input) => {
			const session = sessions.get(input.process_id);
			if (!session || session.hidden) {
				throw new Error(`Unknown process id ${input.process_id}`);
			}
			if (input.chars && input.chars.length > 0) {
				if (!session.interactive) {
					throw new Error("stdin is closed for this session; rerun exec_command with tty=true to keep stdin open");
				}
				if (session.kind === "pty") {
					session.child.write(input.chars);
				} else {
					session.child.stdin.write(input.chars);
				}
			}
			const waitedMs = isRunning(session)
				? await waitForExitOrTimeout(
						session,
						clampWriteYieldTime(
							input.yield_time_ms,
							defaultWriteYieldTimeMs,
							!input.chars || input.chars.length === 0,
							minEmptyWriteYieldTimeMs,
						),
					)
				: 0;
			return makeResult(session, waitedMs);
		},
		hasSession: (sessionId) => {
			const session = sessions.get(sessionId);
			return session !== undefined && !session.hidden;
		},
		getSessionCommand: (sessionId) => sessions.get(sessionId)?.command ?? commandHistory.get(sessionId),
		getSessionSnapshot: (sessionId) => {
			const session = sessions.get(sessionId);
			if (!session) return undefined;
			const running = isRunning(session);
			const truncated = formattedTruncateText(session.buffer);
			return {
				command: session.command,
				output: truncated.output,
				running,
				exitCode: session.terminalState === "exited" ? (session.exitCode ?? 0) : undefined,
				terminalState: session.terminalState,
				timedOut: session.terminalState === "timed_out" ? true : undefined,
				cancelled: session.terminalState === "cancelled" ? true : undefined,
				sessionError: session.sessionError,
				stdinOpen: running ? session.interactive : undefined,
				elapsedMs: Date.now() - session.startedAtMs,
				originalTokenCount: truncated.output_truncated ? approxTokenCount(session.buffer) : undefined,
				outputTruncated: truncated.output_truncated === true,
			};
		},
		listSessions: () =>
			Array.from(sessions.values())
				.filter((session) => !session.hidden)
				.map(toRecord),
		stopSession: (sessionId) => {
			const session = sessions.get(sessionId);
			if (!session || session.hidden) return false;
			session.hidden = true;
			terminateSession(session);
			notifySessionUpdate();
			return true;
		},
		stopAllSessions: () => {
			let stopped = 0;
			for (const session of sessions.values()) {
				if (session.hidden) continue;
				session.hidden = true;
				terminateSession(session);
				stopped++;
			}
			if (stopped > 0) {
				notifySessionUpdate();
			}
			return stopped;
		},
		onSessionExit: (listener) => {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onSessionUpdate: (listener) => {
			updateListeners.add(listener);
			return () => updateListeners.delete(listener);
		},
		shutdown: () => {
			for (const session of sessions.values()) {
				terminateSession(session);
			}
			const hadSessions = sessions.size > 0;
			sessions.clear();
			commandHistory.clear();
			if (hadSessions) {
				notifySessionUpdate();
			}
		},
	};
}
