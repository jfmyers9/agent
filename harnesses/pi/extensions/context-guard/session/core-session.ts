import { invokeCoreSync, parseCoreJson } from "../pi/core.js";

export interface HookInput {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_response?: string;
	tool_output?: { isError?: boolean; is_error?: boolean };
}

export interface SessionEventWrite {
	type: string;
	category: string;
	data: string;
	priority: number;
	dataHash?: string;
	projectDir?: string;
	attributionSource?: string;
	attributionConfidence?: number;
	bytesAvoided?: number;
	bytesReturned?: number;
}

export interface SessionQueryEvent {
	id: number;
	session_id: string;
	type: string;
	category: string;
	priority: number;
	data: string;
	project_dir: string;
	attribution_source: string;
	attribution_confidence: number;
	bytes_avoided: number;
	bytes_returned: number;
	source_hook: string;
	created_at: string;
	data_hash: string;
}

export interface SessionQueryStats {
	session_id?: string;
	project_dir?: string;
	started_at?: string;
	last_event_at?: string | null;
	event_count?: number;
	compact_count?: number;
}

export interface SessionQueryResume {
	snapshot: string;
	eventCount: number;
	consumed: boolean;
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

export interface SessionBeforeAgentStartResult {
	activeMemory?: string;
	resumeSnapshot?: string;
	systemPrompt?: string;
}

export interface SessionBeforeCompactResult {
	snapshot?: string;
	eventCount?: number;
}

export interface SessionToolCallCheckResult {
	block?: boolean;
	reason?: string;
}

export interface SessionQueryResult {
	latestSessionId?: string;
	events?: SessionQueryEvent[];
	stats?: SessionQueryStats | null;
	resume?: SessionQueryResume | null;
	eventCount?: number;
	toolCallStats?: SessionToolCallStats | null;
}

function callSession<T>(params: Record<string, unknown>): T | null {
	return parseCoreJson<T>(invokeCoreSync("session", params));
}

export function sessionExtractHookEvents(opts: {
	sessionDbPath: string;
	sessionId?: string;
	projectDir?: string;
	hookInput: HookInput;
	fallbackToolName?: string;
}): SessionEventWrite[] {
	return (
		callSession<SessionEventWrite[]>({
			action: "extract_hook_events",
			sessionDbPath: opts.sessionDbPath,
			sessionId: opts.sessionId,
			projectDir: opts.projectDir,
			hookInput: opts.hookInput,
			fallbackToolName: opts.fallbackToolName,
		}) ?? []
	);
}

export function sessionCheckToolCall(opts: {
	sessionDbPath: string;
	hookInput: HookInput;
}): SessionToolCallCheckResult | null {
	return callSession<SessionToolCallCheckResult>({
		action: "check_tool_call",
		sessionDbPath: opts.sessionDbPath,
		hookInput: opts.hookInput,
	});
}

export function sessionBuildPiCheck(opts: {
	sessionDbPath: string;
	sessionId?: string;
	dbPath: string;
	pluginRoot: string;
	projectDir: string;
}): string {
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

export function sessionPrepareBeforeAgentStart(opts: {
	sessionDbPath: string;
	sessionId: string;
	projectDir?: string;
	prompt?: string;
	systemPrompt?: string;
}): SessionBeforeAgentStartResult | null {
	return callSession<SessionBeforeAgentStartResult>({
		action: "prepare_before_agent_start",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		projectDir: opts.projectDir,
		message: opts.prompt,
		systemPrompt: opts.systemPrompt,
	});
}

export function sessionRecordProviderResponse(opts: {
	sessionDbPath: string;
	sessionId: string;
	projectDir?: string;
	providerMeta: Record<string, unknown>;
}): void {
	callSession({
		action: "record_provider_response",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		projectDir: opts.projectDir,
		providerMeta: opts.providerMeta,
	});
}

export function sessionPrepareBeforeCompact(opts: {
	sessionDbPath: string;
	sessionId: string;
}): SessionBeforeCompactResult | null {
	return callSession<SessionBeforeCompactResult>({
		action: "prepare_before_compact",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
	});
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

export function sessionWriteEvents(opts: {
	sessionDbPath: string;
	sessionId?: string;
	projectDir?: string;
	sourceHook?: string;
	events: SessionEventWrite[];
}): void {
	if (opts.events.length === 0) return;
	callSession({
		action: "events",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		projectDir: opts.projectDir,
		sourceHook: opts.sourceHook,
		events: opts.events,
	});
}

export function sessionRecordToolTelemetry(opts: {
	sessionDbPath: string;
	sessionId?: string;
	projectDir?: string;
	toolName: string;
	bytesReturned?: number;
	source?: string;
	bytesAvoided?: number;
}): void {
	callSession({
		action: "record_tool_telemetry",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		projectDir: opts.projectDir,
		toolName: opts.toolName,
		bytesReturned: opts.bytesReturned,
		source: opts.source,
		bytesAvoided: opts.bytesAvoided,
	});
}

export function sessionQuery(opts: {
	sessionDbPath: string;
	sessionId?: string;
	minPriority?: number;
	limit?: number;
	includeStats?: boolean;
	includeResume?: boolean;
	includeEventCount?: boolean;
	includeToolCallStats?: boolean;
	latestSessionId?: boolean;
}): SessionQueryResult | null {
	return callSession<SessionQueryResult>({
		action: "query",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
		minPriority: opts.minPriority,
		limit: opts.limit,
		includeStats: opts.includeStats,
		includeResume: opts.includeResume,
		includeEventCount: opts.includeEventCount,
		includeToolCallStats: opts.includeToolCallStats,
		latestSessionId: opts.latestSessionId,
	});
}

export function sessionIncrementCompactCount(opts: { sessionDbPath: string; sessionId: string }): void {
	callSession({
		action: "increment_compact_count",
		sessionDbPath: opts.sessionDbPath,
		sessionId: opts.sessionId,
	});
}
