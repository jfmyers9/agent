import { buildCoreCheckText, invokeCore, invokeCoreSync, parseCoreJson, resolveCoreBin } from "../pi/core.js";

export interface SessionQueryStats {
	session_id?: string;
	project_dir?: string;
	started_at?: string;
	last_event_at?: string | null;
}

export interface SessionToolCallByTool {
	calls: number;
	bytesReturned: number;
}

export interface SessionToolCallStats {
	totalCalls: number;
	totalBytesReturned: number;
	byTool: Record<string, SessionToolCallByTool>;
}

export interface SessionQueryResult {
	latestSessionId?: string;
	stats?: SessionQueryStats | null;
	toolCallStats?: SessionToolCallStats | null;
}

function callSession<T>(params: Record<string, unknown>): T | null {
	return parseCoreJson<T>(invokeCoreSync("session", params));
}

export function sessionBuildPiCheck(opts: {
	sessionDbPath: string;
	sessionId?: string;
	dbPath: string;
	pluginRoot: string;
	projectDir: string;
}): string {
	if (!resolveCoreBin()) return buildCoreCheckText();
	return (
		callSession<string>({
			action: "build_pi_check",
			sessionDbPath: opts.sessionDbPath,
			sessionId: opts.sessionId,
			dbPath: opts.dbPath,
			pluginRoot: opts.pluginRoot,
			projectDir: opts.projectDir,
		}) ?? "context-guard: diagnostics unavailable"
	);
}

export function sessionInit(opts: {
	sessionDbPath: string;
	sessionId: string;
	projectDir: string;
	maxAgeDays?: number;
}): void {
	callSession({
		action: "init",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		projectDir: opts.projectDir,
		maxAgeDays: opts.maxAgeDays,
	});
}
export async function sessionRecordToolTelemetry(opts: {
	sessionDbPath: string;
	sessionId?: string;
	projectDir?: string;
	toolName: string;
	bytesReturned?: number;
	rawBytes?: number;
	indexedBytes?: number;
	omittedBytes?: number;
	elapsedMs?: number;
	success?: boolean;
}): Promise<void> {
	await invokeCore("session", {
		action: "record_tool_telemetry",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		projectDir: opts.projectDir,
		toolName: opts.toolName,
		bytesReturned: opts.bytesReturned,
		rawBytes: opts.rawBytes,
		indexedBytes: opts.indexedBytes,
		omittedBytes: opts.omittedBytes,
		elapsedMs: opts.elapsedMs,
		success: opts.success,
	});
}

export function sessionQuery(opts: {
	sessionDbPath: string;
	sessionId?: string;
	includeStats?: boolean;
	includeToolCallStats?: boolean;
	latestSessionId?: boolean;
}): SessionQueryResult | null {
	return callSession<SessionQueryResult>({
		action: "query",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		includeStats: opts.includeStats,
		includeToolCallStats: opts.includeToolCallStats,
		latestSessionId: opts.latestSessionId,
	});
}
