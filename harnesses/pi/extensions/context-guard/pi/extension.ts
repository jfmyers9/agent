/**
 * Pi coding agent extension for context-guard.
 *
 * Imports shared session modules and registers Pi-specific hooks.
 * NO external npm dependencies beyond what Pi runtime provides.
 *
 * Entry point: `export default function(pi: ExtensionAPI) { ... }`
 *
 * Lifecycle: session_start, tool_call, tool_result, before_agent_start,
 * session_before_compact, session_compact, session_shutdown.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookInput } from "../session/core-session.js";
import {
	sessionBuildPiCheck,
	sessionCheckToolCall,
	sessionExtractHookEvents,
	sessionIncrementCompactCount,
	sessionInit,
	sessionPrepareBeforeAgentStart,
	sessionPrepareBeforeCompact,
	sessionRecordProviderResponse,
	sessionWriteEvents,
} from "../session/core-session.js";
import { resolveContentStorePath, resolveSessionDbPath } from "../session/paths.js";
import { invokeCoreSync } from "./core.js";
import { getPiConfigDir, getPiSessionDir, markExecCommandContextGuardEnabled } from "./index.js";
import { registerPiContextTools } from "./tools.js";

const PI_WORKSPACE_ENV_VARS = ["PI_WORKSPACE_DIR", "PI_PROJECT_DIR"] as const;

let _sessionId = "";

/**
 * Direct tool registration is synchronous, but tests use this promise to
 * await a consistent post-registration point.
 */
export let _toolRuntimeReady: Promise<void> = Promise.resolve();

// ── Helpers ──────────────────────────────────────────────

function getSessionDir(): string {
	const dir = getPiSessionDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

function getDBPath(projectDir: string): string {
	return resolveSessionDbPath({
		projectDir,
		sessionsDir: getSessionDir(),
	});
}

/** Derive a stable session ID from Pi's session file path (SHA256, 16 hex chars). */
function deriveSessionId(ctx: Record<string, unknown>): string {
	try {
		const sessionManager = ctx.sessionManager as { getSessionFile?: () => string } | undefined;
		const sessionFile = sessionManager?.getSessionFile?.();
		if (sessionFile && typeof sessionFile === "string") {
			return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
		}
	} catch {
		// best effort
	}
	return `pi-${Date.now()}`;
}

function getStorePath(projectDir: string): string {
	const dir = join(dirname(getSessionDir()), "content");
	mkdirSync(dir, { recursive: true });
	return resolveContentStorePath({ projectDir, contentDir: dir });
}

function buildStatsText(projectDir: string): string {
	const response = invokeCoreSync("status", {
		dbPath: getStorePath(projectDir),
		sessionDbPath: getDBPath(projectDir),
		sessionsDir: getSessionDir(),
		configDir: getPiConfigDir(),
		cwd: projectDir,
	});
	return response.content[0]?.text ?? "context-guard stats unavailable (rust core error)";
}

function resolveCommandContext(argsOrCtx: unknown, ctx: unknown): any {
	if (ctx !== undefined) return ctx;
	if (argsOrCtx && typeof argsOrCtx === "object") return argsOrCtx;
	return undefined;
}

function handleCommandText(text: string, ctx: any): { text: string } | undefined {
	if (ctx?.hasUI) {
		ctx.ui.notify(text, "info");
		return;
	}

	return { text };
}

type PiCommandApi = {
	registerCommand: (
		name: string,
		def: {
			description: string;
			handler: (...args: unknown[]) => Promise<{ text?: string } | undefined> | { text?: string } | undefined;
		},
	) => void;
};

function registerTextCommand(
	pi: PiCommandApi,
	name: string,
	description: string,
	build: () => string | Promise<string>,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (argsOrCtx: unknown, maybeCtx: unknown) => {
			const ctx = resolveCommandContext(argsOrCtx, maybeCtx);
			return handleCommandText(await build(), ctx);
		},
	});
}

/**
 * Issue #545 — Pi workspace resolver.
 *
 * Pi's runtime sets PI_CONFIG_DIR to ~/.pi (its CONFIG dir, not the user's
 * project). The extension previously used this as the project anchor, which
 * meant every Pi session re-rooted under ~/.pi — collapsing all of a user's
 * projects into a single phantom workspace. This helper picks the user's
 * actual project directory while NEVER returning a path equal to or under
 * ~/.pi/.
 *
 * Cascade:
 *   1. PI_WORKSPACE_DIR — set by Pi's bridge (extension-set, freshest)
 *   2. PI_PROJECT_DIR   — legacy/user override
 *   3. PWD              — shell-set, survives process.chdir
 *   4. cwd              — last resort
 *
 * Each candidate is rejected if it equals ~/.pi or lives under ~/.pi/. If
 * every candidate is poisoned, falls back to homedir() as a safe non-config
 * anchor — caller may still render a "no project context" notice but the
 * function stays total.
 */
export function resolvePiWorkspaceDir(opts: {
	env: Record<string, string | undefined>;
	pwd: string | undefined;
	cwd: string;
	/** Optional override for tests; defaults to `os.homedir()`. */
	home?: string;
}): string {
	const home = opts.home ?? homedir();
	const piConfigDir = join(home, ".pi");
	const isUnderPi = (p: string | undefined): boolean => {
		if (!p) return true;
		if (p === piConfigDir) return true;
		// Match both POSIX (/) and Windows (\) child-of relations.
		return p.startsWith(`${piConfigDir}/`) || p.startsWith(`${piConfigDir}\\`);
	};
	const candidates = [...PI_WORKSPACE_ENV_VARS.map((name) => opts.env[name]), opts.pwd, opts.cwd];
	for (const c of candidates) {
		if (c && !isUnderPi(c)) return c;
	}
	return home;
}

// ── Extension entry point ────────────────────────────────

/** Pi extension default export. Called once by Pi runtime with the extension API. */
export default function piExtension(pi: any): void {
	markExecCommandContextGuardEnabled();
	const buildDir = dirname(fileURLToPath(import.meta.url));
	const pluginRoot = resolve(buildDir, "..", "..", "..");
	// Issue #545 — Pi workspace resolver. PI_CONFIG_DIR is Pi's CONFIG dir
	// (~/.pi), NOT the user's workspace; using it as the project anchor
	// collapsed every Pi session into a single phantom workspace. The
	// dedicated resolver picks PI_WORKSPACE_DIR > PI_PROJECT_DIR > PWD > cwd
	// and refuses to return any path under ~/.pi/.
	const projectDir = resolvePiWorkspaceDir({
		env: process.env,
		pwd: process.env.PWD,
		cwd: process.cwd(),
	});
	const sessionDbPath = getDBPath(projectDir);

	// ── 1. session_start — Initialize session ──────────────

	pi.on("session_start", (_event: any, ctx: any) => {
		try {
			_sessionId = deriveSessionId(ctx ?? {});
			sessionInit({
				sessionDbPath,
				sessionId: _sessionId,
				projectDir,
				maxAgeDays: 7,
			});
		} catch {
			// best effort — never break session start
			if (!_sessionId) {
				_sessionId = `pi-${Date.now()}`;
			}
		}
	});

	// ── 2. tool_call — PreToolUse routing enforcement ──────
	// Block bash commands that contain curl/wget/fetch/requests patterns.

	pi.on("tool_call", (event: any) => {
		try {
			const result = sessionCheckToolCall({
				sessionDbPath,
				hookInput: {
					tool_name: String(event?.toolName ?? ""),
					tool_input: (event?.input ?? {}) as Record<string, unknown>,
				},
			});
			if (result?.block) {
				return {
					block: true,
					reason: result.reason ?? "Command blocked by context-guard",
				};
			}
		} catch {
			// Routing failure — allow passthrough
		}
	});

	// ── 3. tool_result — PostToolUse event capture ─────────

	pi.on("tool_result", (event: any) => {
		try {
			if (!_sessionId) return;

			const rawToolName = String(event?.toolName ?? event?.tool_name ?? "");

			// Normalize result to string
			const rawResult = event?.result ?? event?.output;
			const resultStr =
				typeof rawResult === "string" ? rawResult : rawResult != null ? JSON.stringify(rawResult) : undefined;

			// Detect errors
			const hasError = Boolean(event?.error || event?.isError);

			const hookInput: HookInput = {
				tool_name: rawToolName,
				tool_input: event?.params ?? event?.input ?? {},
				tool_response: resultStr,
				tool_output: hasError ? { isError: true } : undefined,
			};

			const events = sessionExtractHookEvents({
				sessionDbPath,
				sessionId: _sessionId,
				projectDir,
				hookInput,
				fallbackToolName: rawToolName,
			});

			if (events.length > 0) {
				sessionWriteEvents({
					sessionDbPath,
					sessionId: _sessionId,
					projectDir,
					sourceHook: "PostToolUse",
					events,
				});
			}
		} catch {
			// Silent — session capture must never break the tool call
		}
	});

	// ── 4. before_agent_start — Routing + active_memory + resume injection ─

	pi.on("before_agent_start", (event: any) => {
		try {
			if (!_sessionId) return;

			const prepared = sessionPrepareBeforeAgentStart({
				sessionDbPath,
				sessionId: _sessionId,
				projectDir,
				prompt: String(event?.prompt ?? ""),
				systemPrompt: String(event?.systemPrompt ?? ""),
			});
			if (prepared?.systemPrompt) {
				return { systemPrompt: prepared.systemPrompt };
			}
		} catch {
			// best effort — never break agent start
		}
	});

	// ── 4b. before_provider_response — capture response metadata ───
	// Pi-2: Register the missing event so providers can record latency,
	// model, and token usage when Pi exposes them. Best-effort only;
	// the handler must never throw or modify the response.

	pi.on("before_provider_response", (event: any) => {
		try {
			if (!_sessionId) return;
			const meta = {
				model: event?.model ?? event?.providerModel,
				provider: event?.provider,
				latencyMs: event?.latencyMs ?? event?.latency,
				tokens: event?.usage ?? event?.tokens,
			};
			// Skip when Pi gives us nothing useful — avoids noise in the DB.
			if (meta.model == null && meta.provider == null && meta.latencyMs == null && meta.tokens == null) {
				return;
			}
			sessionRecordProviderResponse({
				sessionDbPath,
				sessionId: _sessionId,
				projectDir,
				providerMeta: meta,
			});
		} catch {
			// best effort — never break provider response
		}
	});

	// ── 5. session_before_compact — Build resume snapshot ──

	pi.on("session_before_compact", () => {
		try {
			if (!_sessionId) return;
			sessionPrepareBeforeCompact({
				sessionDbPath,
				sessionId: _sessionId,
			});
		} catch {
			// best effort — never break compaction
		}
	});

	// ── 6. session_compact — Increment compact counter ─────

	pi.on("session_compact", () => {
		try {
			if (!_sessionId) return;
			sessionIncrementCompactCount({ sessionDbPath, sessionId: _sessionId });
		} catch {
			// best effort
		}
	});

	// ── 7. session_shutdown — Cleanup old sessions ─────────

	pi.on("session_shutdown", async () => {
		try {
			_sessionId = "";
		} catch {
			// best effort — never throw during shutdown
		}
	});

	// ── 8. Slash commands ──────────────────────────────────

	registerTextCommand(pi, "cg-status", "Show context-guard session statistics", () =>
		!_sessionId ? "context-guard: no active session" : buildStatsText(projectDir),
	);

	registerTextCommand(pi, "cg-check", "Run context-guard diagnostics", () => {
		return sessionBuildPiCheck({
			sessionDbPath,
			sessionId: _sessionId || undefined,
			dbPath: getDBPath(projectDir),
			pluginRoot,
			projectDir,
		});
	});

	registerPiContextTools(pi);
	_toolRuntimeReady = Promise.resolve();
}
