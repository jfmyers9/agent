// @ts-nocheck

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerCodeModeTool } from "../../shared/code-mode.ts";
import { summarizeShellCommand } from "../shell/summary.ts";
import { rawCommandToExecCell, renderExecCellComponent } from "./exec-cell-presentation.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { boundShellToolResult } from "./output-truncation.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const EXEC_COMMAND_PARAMETERS = Type.Object({
	cmd: Type.String({ description: "Shell command to execute." }),
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
			description: "Optional timeout in milliseconds for the command.",
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
}

interface ExecCommandToolOptions {
	onResult?: (
		params: ExecCommandParams,
		result: UnifiedExecResult,
		ctx: ExtensionContext,
	) => { terminate?: boolean } | undefined;
}

function prepareExecCommandArguments(args: unknown): ExecCommandParams {
	if (!args || typeof args !== "object") {
		return args as ExecCommandParams;
	}

	const record = args as Record<string, unknown>;
	const prepared: Record<string, unknown> = { ...record };
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
	return prepared as unknown as ExecCommandParams;
}

function parseExecCommandParams(params: unknown): ExecCommandParams {
	if (!params || typeof params !== "object") {
		throw new Error("exec_command requires an object parameter");
	}

	const cmd = "cmd" in params ? params.cmd : undefined;
	if (typeof cmd !== "string") {
		throw new Error("exec_command requires a string 'cmd' parameter");
	}

	return {
		cmd,
		workdir: "workdir" in params && typeof params.workdir === "string" ? params.workdir : undefined,
		shell: "shell" in params && typeof params.shell === "string" ? params.shell : undefined,
		tty: "tty" in params && typeof params.tty === "boolean" ? params.tty : undefined,
		yield_time_ms:
			"yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined,
		login: "login" in params && typeof params.login === "boolean" ? params.login : undefined,
		timeout: "timeout" in params && typeof params.timeout === "number" ? params.timeout : undefined,
	};
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function createEmptyResultComponent(): Container {
	return new Container();
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
			}
		: rawCommandToExecCell({
				command,
				status: renderInfo.status,
				failed,
				elapsedMs: renderInfo.elapsedMs,
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
	let footer =
		details?.exit_code !== undefined && details.exit_code !== 0
			? theme.fg("muted", `Exit code: ${details.exit_code}`)
			: undefined;
	if (details?.output_truncated && details.full_output_path) {
		footer = [footer, theme.fg("muted", `Full output: ${details.full_output_path}`)].filter(Boolean).join("\n");
	}
	return renderExecCellComponent(
		rawCommandToExecCell({
			command: command ?? "",
			status: renderInfo.status,
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
	registerCodeModeTool(
		pi,
		{
			name: "exec_command",
			label: "exec_command",
			description:
				"Runs a shell command using plain pipes or an optional PTY, returning bounded output or a process ID for continued interaction. Full output is saved to full_output_path.",
			renderShell: "self",
			promptSnippet: "Run shell commands for builds, tests, git, process inspection, and other shell-only workflows.",
			promptGuidelines: [
				"Use exec_command for shell-only workflows; prefer active dedicated file tools for reading, content search, and file discovery when they are available.",
				"When using shell search, prefer `rg`/`rg --files` over `grep` or shell `find`; for broad searches use line-safe `rg -n -M 400 --max-columns-preview` plus narrow globs.",
				"Use full_output_path for targeted reads or searches when command output is truncated.",
				"Keep tty disabled unless the command truly needs interactive terminal behavior.",
			],
			parameters: EXEC_COMMAND_PARAMETERS,
			prepareArguments: prepareExecCommandArguments,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (signal?.aborted) {
					throw new Error("exec_command aborted");
				}
				const typedParams = parseExecCommandParams(params);
				const command = typedParams.cmd;
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
				renderExecCommandResultWithOptionalContext(result, options, theme, context, tracker, sessions)) as any,
		},
		{ mapResult: boundShellToolResult },
	);
}
