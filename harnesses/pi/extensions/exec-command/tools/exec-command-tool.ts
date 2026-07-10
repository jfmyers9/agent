// @ts-nocheck
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { invokeCore } from "../../context-guard/pi/core.ts";
import { getPiSessionDir } from "../../context-guard/pi/index.ts";
import { sessionRecordToolTelemetry } from "../../context-guard/session/core-session.ts";
import { resolveContentStorePath, resolveSessionDbPath } from "../../context-guard/session/paths.ts";
import { summarizeShellCommand } from "../shell/summary.ts";
import { rawCommandToExecCell, renderExecCellComponent } from "./exec-cell-presentation.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { commandHasRipgrepSegment, isRtkGrepCommand } from "./rtk-wrapper.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const EXEC_COMMAND_PARAMETERS = Type.Object({
	mode: Type.Optional(
		Type.Literal("batch", {
			description:
				"Optional special mode. Use 'batch' for context-guard batched command+search; omit for normal shell commands.",
		}),
	),
	cmd: Type.Optional(Type.String({ description: "Shell command to execute." })),
	workdir: Type.Optional(
		Type.String({
			description: "Optional working directory; defaults to the current turn cwd.",
		}),
	),
	shell: Type.Optional(
		Type.String({
			description: "Optional shell binary; defaults to the user's shell.",
		}),
	),
	tty: Type.Optional(
		Type.Boolean({
			description:
				"Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process.",
		}),
	),
	yield_time_ms: Type.Optional(
		Type.Number({
			description: "How long to wait in milliseconds for output before yielding.",
		}),
	),
	login: Type.Optional(
		Type.Boolean({
			description: "Whether to run the shell with -l/-i semantics. Defaults to true.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Optional timeout in milliseconds for raw managed commands, Context Guard wrapping, or mode:'batch'.",
		}),
	),
	context_guard: Type.Optional(
		Type.Boolean({
			description:
				"Optional per-call override for Context Guard wrapping. Defaults to the global exec-command setting. Rarely needed.",
		}),
	),
	contextGuard: Type.Optional(
		Type.Boolean({
			description:
				"camelCase alias of context_guard. Optional per-call override for Context Guard wrapping. Rarely needed.",
		}),
	),
	commands: Type.Optional(
		Type.Any({
			description:
				"For mode:'batch': commands to execute, as [{label, command}, ...] or a JSON string/array of command strings.",
		}),
	),
	queries: Type.Optional(
		Type.Any({
			description:
				"For mode:'batch': optional search queries to run against the indexed command output. Omit to return raw command sections only.",
		}),
	),
	concurrency: Type.Optional(
		Type.Number({
			description: "For mode:'batch': max commands to run in parallel.",
		}),
	),
});

interface ExecCommandParams {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	login?: boolean;
	timeout?: number;
	contextGuard?: boolean;
}

interface ContextGuardBatchCommand {
	label: string;
	command: string;
}

interface ContextGuardBatchParams {
	mode: "batch";
	workdir?: string;
	commands: ContextGuardBatchCommand[];
	queries?: string[];
	timeout?: number;
	concurrency?: number;
}

type ParsedExecInvocation =
	| { kind: "command"; params: ExecCommandParams }
	| { kind: "batch"; params: ContextGuardBatchParams };

type ExecCommandRewrite = string | { command: string; rtkWrapped?: boolean };

interface ExecCommandToolOptions {
	rewriteCommand?: (command: string, ctx: ExtensionContext) => Promise<ExecCommandRewrite> | ExecCommandRewrite;
	onResult?: (
		params: ExecCommandParams,
		result: UnifiedExecResult,
		ctx: ExtensionContext,
	) => { terminate?: boolean } | undefined;
	contextGuardEnabled?: () => boolean;
}

type ContextGuardBatchCoreResult = {
	label?: string;
	command?: string;
	output?: string;
	summary?: string;
	exitCode?: number | null;
};

type ContextGuardBatchCoreDetails = {
	results?: ContextGuardBatchCoreResult[];
	commandCount?: number;
	concurrency?: number;
	queries?: string[];
};

type ContextGuardBatchRenderDetails = {
	contextGuardBatch: true;
	output: string;
	commandCount: number;
	queryCount: number;
	commandPreview: string;
};

function prepareExecCommandArguments(args: unknown): ExecCommandParams {
	if (!args || typeof args !== "object") {
		return args as ExecCommandParams;
	}

	const record = args as Record<string, unknown>;
	const prepared: Record<string, unknown> = { ...record };
	if (typeof prepared.mode !== "string" && !("cmd" in prepared) && !("command" in prepared) && "commands" in prepared) {
		prepared.mode = "batch";
	}
	if (!("cmd" in prepared) && "command" in prepared) {
		prepared.cmd = prepared.command;
	}
	if (!("workdir" in prepared)) {
		if ("cwd" in prepared) {
			prepared.workdir = prepared.cwd;
		} else if ("working_directory" in prepared) {
			prepared.workdir = prepared.working_directory;
		}
	}
	if (prepared.mode === "batch") {
		prepared.commands = coerceCommandsArray(prepared.commands);
		prepared.queries = coerceJsonArray(prepared.queries);
	}
	return prepared as unknown as ExecCommandParams;
}

function parseExecCommandParams(params: unknown): ParsedExecInvocation {
	if (!params || typeof params !== "object") {
		throw new Error("exec_command requires an object parameter");
	}

	const record = params as Record<string, unknown>;
	const mode = "mode" in record ? record.mode : undefined;
	if (mode !== undefined && mode !== "batch" && mode !== "command") {
		throw new Error("exec_command mode must be 'batch' when provided");
	}

	if (mode === "batch" || (!("cmd" in record) && Array.isArray(record.commands))) {
		const commands = normalizeContextGuardBatchCommands(record.commands);
		if (commands.length === 0) {
			throw new Error("exec_command mode 'batch' requires a non-empty 'commands' array");
		}
		return {
			kind: "batch",
			params: {
				mode: "batch",
				workdir: typeof record.workdir === "string" ? record.workdir : undefined,
				commands,
				queries: normalizeContextGuardQueries(record.queries),
				timeout: typeof record.timeout === "number" ? record.timeout : undefined,
				concurrency: typeof record.concurrency === "number" ? record.concurrency : undefined,
			},
		};
	}

	const cmd = "cmd" in params ? params.cmd : undefined;
	if (typeof cmd !== "string") {
		throw new Error("exec_command requires a string 'cmd' parameter");
	}

	return {
		kind: "command",
		params: {
			cmd,
			workdir: "workdir" in params && typeof params.workdir === "string" ? params.workdir : undefined,
			shell: "shell" in params && typeof params.shell === "string" ? params.shell : undefined,
			tty: "tty" in params && typeof params.tty === "boolean" ? params.tty : undefined,
			yield_time_ms:
				"yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined,
			login: "login" in params && typeof params.login === "boolean" ? params.login : undefined,
			timeout: "timeout" in params && typeof params.timeout === "number" ? params.timeout : undefined,
			contextGuard: readContextGuardOverride(record),
		},
	};
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function isContextGuardBatchCoreDetails(details: unknown): details is ContextGuardBatchCoreDetails {
	return typeof details === "object" && details !== null;
}

function isContextGuardBatchRenderDetails(details: unknown): details is ContextGuardBatchRenderDetails {
	return (
		typeof details === "object" &&
		details !== null &&
		(details as Record<string, unknown>).contextGuardBatch === true &&
		typeof (details as Record<string, unknown>).output === "string"
	);
}

function readContextGuardOverride(record: Record<string, unknown>): boolean | undefined {
	if (typeof record.context_guard === "boolean") return record.context_guard;
	if (typeof record.contextGuard === "boolean") return record.contextGuard;
	return undefined;
}

function coerceJsonArray(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// ignore
		}
	}
	return value;
}

function coerceCommandsArray(value: unknown): unknown {
	const parsed = coerceJsonArray(value);
	if (!Array.isArray(parsed)) return parsed;
	return parsed.map((item, index) => (typeof item === "string" ? { label: `cmd_${index + 1}`, command: item } : item));
}

function normalizeContextGuardBatchCommands(value: unknown): ContextGuardBatchCommand[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		if (typeof item === "string") {
			return [{ label: `cmd_${index + 1}`, command: item }];
		}
		if (
			item &&
			typeof item === "object" &&
			typeof (item as Record<string, unknown>).label === "string" &&
			typeof (item as Record<string, unknown>).command === "string"
		) {
			return [
				{
					label: (item as Record<string, string>).label,
					command: (item as Record<string, string>).command,
				},
			];
		}
		return [];
	});
}

function normalizeContextGuardQueries(value: unknown): string[] {
	const parsed = coerceJsonArray(value);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((item): item is string => typeof item === "string");
}

function resolveContextGuardProjectDir(workdir: string | undefined, ctx: ExtensionContext): string {
	return workdir ?? ctx.cwd;
}

function resolveContextGuardPaths(projectDir: string): { dbPath: string; sessionDbPath: string } {
	const sessionsDir = getPiSessionDir();
	const contentDir = join(dirname(sessionsDir), "content");
	mkdirSync(contentDir, { recursive: true });
	return {
		dbPath: resolveContentStorePath({ projectDir, contentDir }),
		sessionDbPath: resolveSessionDbPath({ projectDir, sessionsDir }),
	};
}

function contextGuardResponseText(response: { content?: Array<{ type?: string; text?: string }> }): string {
	return (response.content ?? [])
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function labelForWrappedCommand(command: string): string {
	const normalized = command.trim().replace(/\s+/g, " ");
	return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function makeWrappedCommandResult(
	command: string,
	responseText: string,
	details: ContextGuardBatchCoreDetails | undefined,
	responseIsError: boolean,
) {
	const first = details?.results?.[0];
	const output = typeof first?.output === "string" ? first.output : responseText;
	const exitCode = typeof first?.exitCode === "number" ? first.exitCode : undefined;
	const unified: UnifiedExecResult = {
		chunk_id: "context-guard-batch",
		wall_time_seconds: 0,
		output,
		...(exitCode !== undefined ? { exit_code: exitCode } : {}),
	};
	return {
		content: [{ type: "text", text: formatUnifiedExecResult(unified, command) }],
		details: unified,
		isError: exitCode !== undefined ? exitCode !== 0 : responseIsError,
	};
}

function makeBatchRenderDetails(params: ContextGuardBatchParams, output: string): ContextGuardBatchRenderDetails {
	const commandPreview =
		params.commands.length === 1 ? params.commands[0]!.command : `${params.commands.length} batched commands`;
	return {
		contextGuardBatch: true,
		output,
		commandCount: params.commands.length,
		queryCount: params.queries?.length ?? 0,
		commandPreview,
	};
}

async function executeContextGuardBatch(
	params: ContextGuardBatchParams,
	ctx: ExtensionContext,
): Promise<{
	toolName: "exec_command.batch";
	projectDir: string;
	sessionDbPath: string;
	responseText: string;
	responseIsError: boolean;
	details: ContextGuardBatchCoreDetails | undefined;
}> {
	const projectDir = resolveContextGuardProjectDir(params.workdir, ctx);
	const { dbPath, sessionDbPath } = resolveContextGuardPaths(projectDir);
	const response = await invokeCore("batch", {
		dbPath,
		commands: params.commands,
		queries: params.queries,
		timeout: params.timeout,
		concurrency: params.concurrency,
		projectDir,
	});
	return {
		toolName: "exec_command.batch",
		projectDir,
		sessionDbPath,
		responseText: contextGuardResponseText(response),
		responseIsError: response.isError === true || response.ok === false,
		details: isContextGuardBatchCoreDetails(response.details) ? response.details : undefined,
	};
}

async function executeWrappedCommandWithContextGuard(
	params: ExecCommandParams,
	executedCommand: string,
	ctx: ExtensionContext,
) {
	const batch = await executeContextGuardBatch(
		{
			mode: "batch",
			workdir: params.workdir,
			commands: [{ label: labelForWrappedCommand(params.cmd), command: executedCommand }],
			timeout: params.timeout,
		},
		ctx,
	);
	setImmediate(() =>
		sessionRecordToolTelemetry({
			sessionDbPath: batch.sessionDbPath,
			projectDir: batch.projectDir,
			toolName: batch.toolName,
			bytesReturned: Buffer.byteLength(batch.responseText),
		}),
	);
	return makeWrappedCommandResult(params.cmd, batch.responseText, batch.details, batch.responseIsError);
}

async function executeExplicitBatch(params: ContextGuardBatchParams, ctx: ExtensionContext) {
	const batch = await executeContextGuardBatch(params, ctx);
	setImmediate(() =>
		sessionRecordToolTelemetry({
			sessionDbPath: batch.sessionDbPath,
			projectDir: batch.projectDir,
			toolName: batch.toolName,
			bytesReturned: Buffer.byteLength(batch.responseText),
		}),
	);
	return {
		content: [{ type: "text", text: batch.responseText }],
		details: makeBatchRenderDetails(params, batch.responseText),
		isError: batch.responseIsError,
	};
}

function shouldRouteCommandThroughContextGuard(params: ExecCommandParams, options: ExecCommandToolOptions): boolean {
	if (params.tty) return false;
	if (typeof params.contextGuard === "boolean") return params.contextGuard;
	return options.contextGuardEnabled?.() ?? false;
}

function createEmptyResultComponent(): Container {
	return new Container();
}

function shouldUseRawRipgrep(originalCommand: string, rewrittenCommand: string): boolean {
	return (
		originalCommand !== rewrittenCommand &&
		commandHasRipgrepSegment(originalCommand) &&
		isRtkGrepCommand(rewrittenCommand)
	);
}

interface ExecCommandRenderContextLike {
	toolCallId?: string;
	invalidate?: () => void;
	args?: unknown;
	isError?: boolean;
	isPartial?: boolean;
	lastComponent?: unknown;
	state?: {
		elapsedTimer?: ReturnType<typeof setTimeout>;
	};
}

function renderBatchCallWithOptionalContext(
	args: unknown,
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context: ExecCommandRenderContextLike | undefined,
) {
	if (!args || typeof args !== "object") return null;
	const record = args as Record<string, unknown>;
	if (record.mode !== "batch" && !Array.isArray(record.commands)) return null;
	const commands = normalizeContextGuardBatchCommands(record.commands);
	const commandPreview = commands.length === 1 ? commands[0]!.command : `${commands.length} batched commands`;
	return renderExecCellComponent(
		rawCommandToExecCell({
			command: commandPreview,
			status: context?.isPartial ? "running" : "done",
			contextGuardWrapped: true,
		}),
		{ theme, part: "header" },
		context?.lastComponent,
	);
}

function renderBatchResultWithOptionalContext(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	},
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg(role: string, text: string): string },
) {
	if (options.isPartial) {
		return createEmptyResultComponent();
	}
	const details = isContextGuardBatchRenderDetails(result.details) ? result.details : undefined;
	if (!details) return null;
	return renderExecCellComponent(
		rawCommandToExecCell({
			command: details.commandPreview,
			status: "done",
			contextGuardWrapped: true,
			outputBlock: {
				output: details.output,
				options: { expanded: options.expanded },
			},
		}),
		{ theme, part: "output" },
	);
}

const RUNNING_INVALIDATION_MS = 120;
const elapsedTimersByRenderKey = new Map<string, ReturnType<typeof setTimeout>>();

function elapsedInvalidationKey(
	context: ExecCommandRenderContextLike | undefined,
	command: string,
): string | undefined {
	if (context?.toolCallId) return `call:${context.toolCallId}`;
	return command ? `cmd:${command}` : undefined;
}

function clearElapsedInvalidation(context: ExecCommandRenderContextLike | undefined, command = ""): void {
	const state = context?.state;
	if (state?.elapsedTimer) {
		clearTimeout(state.elapsedTimer);
		state.elapsedTimer = undefined;
	}
	const key = elapsedInvalidationKey(context, command);
	if (!key) return;
	const timer = elapsedTimersByRenderKey.get(key);
	if (!timer) return;
	clearTimeout(timer);
	elapsedTimersByRenderKey.delete(key);
}

function scheduleElapsedInvalidation(
	context: ExecCommandRenderContextLike | undefined,
	running: boolean,
	command = "",
): void {
	if (!running) {
		clearElapsedInvalidation(context, command);
		return;
	}
	if (!context?.invalidate) return;
	const key = elapsedInvalidationKey(context, command);
	if (key && elapsedTimersByRenderKey.has(key)) return;
	const state = context.state;
	if (!key && state?.elapsedTimer) return;
	const timer = setTimeout(() => {
		if (key) elapsedTimersByRenderKey.delete(key);
		if (state?.elapsedTimer === timer) state.elapsedTimer = undefined;
		context.invalidate?.();
	}, RUNNING_INVALIDATION_MS);
	if (key) elapsedTimersByRenderKey.set(key, timer);
	if (state) state.elapsedTimer = timer;
}

const renderExecCommandCallWithOptionalContext: any = (
	args: { cmd?: unknown },
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context: ExecCommandRenderContextLike | undefined,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
) => {
	const command = typeof args.cmd === "string" ? args.cmd : "";
	tracker.ensurePlannedExploration(context?.toolCallId, command);
	const renderInfo = tracker.getRenderInfo(context?.toolCallId, command);
	const failed = context?.isError === true;
	const isExplorationRow = renderInfo.actionGroups !== undefined;
	const snapshot = renderInfo.sessionId !== undefined ? sessions.getSessionSnapshot(renderInfo.sessionId) : undefined;
	const shouldAnimateElapsed =
		context?.isPartial === true && !snapshot?.running && !isExplorationRow && renderInfo.status === "running";
	scheduleElapsedInvalidation(context, shouldAnimateElapsed, command);
	if (renderInfo.hidden) {
		return createEmptyResultComponent();
	}
	if (renderInfo.sessionId !== undefined) {
		const sessionCommand = snapshot?.command ?? sessions.getSessionCommand(renderInfo.sessionId) ?? command;
		return renderExecCellComponent(
			{
				kind: "spawned-background-terminal",
				status: "done",
				command: sessionCommand,
				rtkWrapped: renderInfo.rtkWrapped,
				contextGuardWrapped: renderInfo.contextGuardWrapped,
			},
			{ theme, part: "header" },
			context?.lastComponent,
		);
	}
	const cell = renderInfo.actionGroups
		? {
				kind: "exploration" as const,
				status: renderInfo.status,
				command,
				actionGroups: renderInfo.actionGroups,
				failed,
				elapsedMs: renderInfo.elapsedMs,
				rtkWrapped: renderInfo.rtkWrapped,
				contextGuardWrapped: renderInfo.contextGuardWrapped,
			}
		: rawCommandToExecCell({
				command,
				status: renderInfo.status,
				failed,
				elapsedMs: renderInfo.elapsedMs,
				rtkWrapped: renderInfo.rtkWrapped,
				contextGuardWrapped: renderInfo.contextGuardWrapped,
			});
	return renderExecCellComponent(cell, { theme, part: "header" }, context?.lastComponent);
};

const renderExecCommandResultWithOptionalContext: any = (
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	},
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg(role: string, text: string): string },
	context: ExecCommandRenderContextLike | undefined,
	tracker: ExecCommandTracker,
	_sessions: ExecSessionManager,
) => {
	if (options.isPartial) {
		return createEmptyResultComponent();
	}

	const command =
		context && "args" in context && context.args && typeof (context as any).args.cmd === "string"
			? (context as any).args.cmd
			: undefined;
	const renderInfo = tracker.getRenderInfo(context?.toolCallId, command ?? "");
	if (renderInfo.hidden || renderInfo.actionGroups !== undefined) {
		return createEmptyResultComponent();
	}

	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	if (details?.process_id !== undefined || renderInfo.sessionId !== undefined) {
		return createEmptyResultComponent();
	}
	const content = result.content.find((item) => item.type === "text");
	const output = details?.output ?? (content?.type === "text" ? content.text : "");
	const footer =
		details?.exit_code !== undefined && details.exit_code !== 0
			? theme.fg("muted", `Exit code: ${details.exit_code}`)
			: undefined;
	return renderExecCellComponent(
		rawCommandToExecCell({
			command: command ?? "",
			status: renderInfo.status,
			contextGuardWrapped: renderInfo.contextGuardWrapped,
			outputBlock: {
				output: output ?? "",
				footer,
				options: {
					expanded: options.expanded,
					truncatedAbove: details?.output_truncated,
					originalTokenCount: details?.original_token_count,
				},
			},
		}),
		{ theme, part: "output" },
		context?.lastComponent,
	);
};

export function registerExecCommandTool(
	pi: ExtensionAPI,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
	options: ExecCommandToolOptions = {},
): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description:
			"Runs a shell command in a PTY, with default Context Guard wrapping for non-interactive commands, plus an explicit batch mode for multi-command research workflows.",
		renderShell: "self",
		promptSnippet: "Run shell commands for builds, tests, git, process inspection, and other shell-only workflows.",
		promptGuidelines: [
			"Use exec_command for shell-only workflows; prefer active dedicated file tools for reading, content search, and file discovery when they are available.",
			"Use exec_command(mode:'batch', commands, queries) for multi-command research that should auto-index and search output.",
			"When using shell search, prefer `rg`/`rg --files` over `grep` or shell `find`; for broad searches use line-safe `rg -n -M 400 --max-columns-preview` plus narrow globs.",
			"Keep tty disabled unless the command truly needs interactive terminal behavior.",
		],
		parameters: EXEC_COMMAND_PARAMETERS,
		prepareArguments: prepareExecCommandArguments,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("exec_command aborted");
			}
			const invocation = parseExecCommandParams(params);
			if (invocation.kind === "batch") {
				return executeExplicitBatch(invocation.params, ctx);
			}
			const typedParams = invocation.params;
			if (shouldRouteCommandThroughContextGuard(typedParams, options)) {
				tracker.recordContextGuardWrapped(toolCallId);
				return executeWrappedCommandWithContextGuard(typedParams, typedParams.cmd, ctx);
			}
			const rewrite = options.rewriteCommand ? await options.rewriteCommand(typedParams.cmd, ctx) : typedParams.cmd;
			const rewrittenCommand = typeof rewrite === "string" ? rewrite : rewrite.command;
			const command = shouldUseRawRipgrep(typedParams.cmd, rewrittenCommand) ? typedParams.cmd : rewrittenCommand;
			const rtkWrapped = typeof rewrite === "string" ? command !== typedParams.cmd : rewrite.rtkWrapped === true;
			if (rtkWrapped) {
				tracker.recordRtkWrapped(toolCallId);
			}
			const streamPartialOutput = !summarizeShellCommand(command).maskAsExplored;
			const result = await sessions.exec(
				{ ...typedParams, cmd: command },
				ctx.cwd,
				signal,
				streamPartialOutput
					? (partial) => {
							onUpdate?.({
								content: [
									{
										type: "text",
										text: formatUnifiedExecResult(partial, typedParams.cmd),
									},
								],
								details: partial,
							});
						}
					: undefined,
			);
			if (result.process_id !== undefined) {
				tracker.recordPersistentSession(toolCallId, result.process_id);
			}
			const resultOptions = options.onResult?.(typedParams, result, ctx);
			return {
				content: [
					{
						type: "text",
						text: formatUnifiedExecResult(result, typedParams.cmd),
					},
				],
				details: result,
				isError:
					(result.exit_code !== undefined && result.exit_code !== 0) ||
					result.timed_out === true ||
					result.cancelled === true ||
					result.session_error !== undefined,
				terminate: resultOptions?.terminate,
			};
		},
		renderCall: ((
			args: { cmd?: unknown },
			theme: {
				fg(role: string, text: string): string;
				bold(text: string): string;
			},
			context?: ExecCommandRenderContextLike,
		) =>
			renderBatchCallWithOptionalContext(args, theme, context) ??
			renderExecCommandCallWithOptionalContext(args, theme, context, tracker, sessions)) as any,
		renderResult: ((
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: unknown;
			},
			options: { expanded: boolean; isPartial: boolean },
			theme: { fg(role: string, text: string): string },
			context?: ExecCommandRenderContextLike,
		) =>
			renderBatchResultWithOptionalContext(result, options, theme) ??
			renderExecCommandResultWithOptionalContext(result, options, theme, context, tracker, sessions)) as any,
	});
}
