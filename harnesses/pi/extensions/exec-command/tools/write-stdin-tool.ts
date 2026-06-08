import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderExecCellComponent } from "./exec-cell-presentation.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const WRITE_STDIN_PARAMETERS = Type.Object({
	session_id: Type.Number({
		description: "Identifier of the running unified exec session.",
	}),
	chars: Type.Optional(
		Type.String({
			description: "Bytes to write to stdin. May be empty to poll.",
		}),
	),
	yield_time_ms: Type.Optional(
		Type.Number({
			description: "How long to wait (in milliseconds) for output before yielding.",
		}),
	),
});

interface WriteStdinParams {
	session_id: number;
	chars?: string;
	yield_time_ms?: number;
}

interface FormattedExecTranscript {
	output: string;
	sessionId?: number;
	exitCode?: number;
	stdinOpen?: boolean;
	originalTokenCount?: number;
	outputTruncated?: boolean;
}

function parseFormattedExecTranscript(text: string): FormattedExecTranscript {
	const marker = "\nOutput:\n";
	const markerIndex = text.indexOf(marker);
	const output = markerIndex !== -1 ? text.slice(markerIndex + marker.length) : text;
	const sessionMatch = text.match(/Process running with session ID (\d+)/);
	const exitCodeMatch = text.match(/Process exited with code (-?\d+)/);
	const stdinMatch = text.match(/Stdin: (open|closed)/);
	const ttyMatch = text.match(/TTY: yes/);
	return {
		output,
		sessionId: sessionMatch ? Number(sessionMatch[1]) : undefined,
		exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : undefined,
		stdinOpen: ttyMatch ? true : stdinMatch ? stdinMatch[1] === "open" : undefined,
	};
}

function renderTerminalText(text: string): string {
	let committed = "";
	let line: string[] = [];
	let cursor = 0;

	for (const char of text) {
		switch (char) {
			case "\r":
				cursor = 0;
				break;
			case "\n":
				committed += `${line.join("")}\n`;
				line = [];
				cursor = 0;
				break;
			case "\b":
				cursor = Math.max(0, cursor - 1);
				break;
			default:
				if (cursor > line.length) {
					line.push(...Array.from({ length: cursor - line.length }, () => " "));
				}
				line[cursor] = char;
				cursor += 1;
				break;
		}
	}

	return committed + line.join("");
}

function getResultState(result: {
	details?: unknown;
	content: Array<{ type: string; text?: string }>;
}): FormattedExecTranscript {
	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	const content = result.content.find((item) => item.type === "text");
	if (details) {
		return {
			output: details.output,
			sessionId: details.session_id,
			exitCode: details.exit_code,
			stdinOpen: details.stdin_open,
			originalTokenCount: details.original_token_count,
			outputTruncated: details.output_truncated,
		};
	}
	if (content?.type === "text") {
		return parseFormattedExecTranscript(content.text ?? "");
	}
	return { output: "" };
}

function parseWriteStdinParams(params: unknown): WriteStdinParams {
	if (!params || typeof params !== "object" || !("session_id" in params) || typeof params.session_id !== "number") {
		throw new Error("write_stdin requires numeric 'session_id'");
	}
	const chars = "chars" in params && typeof params.chars === "string" ? params.chars : undefined;
	const yield_time_ms =
		"yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined;
	return {
		session_id: params.session_id,
		chars,
		yield_time_ms,
	};
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function createEmptyResultComponent(): Container {
	return new Container();
}

const BACKGROUND_TERMINAL_HUD_FRAME_MS = 120;
interface RenderContextLike {
	args?: unknown;
	isError?: boolean;
	isPartial?: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: {
		elapsedTimer?: ReturnType<typeof setTimeout>;
		startedAtMs?: number;
	};
}

function isEmptyPoll(params: { chars?: string } | Record<string, unknown> | undefined): boolean {
	if (!params || !("chars" in params)) return true;
	return typeof params.chars !== "string" || params.chars.length === 0;
}

function isEmptyPollRenderContext(context: RenderContextLike | undefined): boolean {
	if (!context?.args || typeof context.args !== "object") return false;
	return isEmptyPoll(context.args as Record<string, unknown>);
}

function elapsedMs(context: RenderContextLike | undefined, running: boolean): number | undefined {
	const state = context?.state;
	if (!running || !state) return undefined;
	state.startedAtMs ??= Date.now();
	return Date.now() - state.startedAtMs;
}

function scheduleRunningInvalidation(context: RenderContextLike | undefined, running: boolean): void {
	const state = context?.state;
	if (!state) return;
	if (!running) {
		if (state.elapsedTimer) {
			clearTimeout(state.elapsedTimer);
			state.elapsedTimer = undefined;
		}
		return;
	}
	if (state.elapsedTimer || !context?.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		context.invalidate?.();
	}, BACKGROUND_TERMINAL_HUD_FRAME_MS);
}

export function registerWriteStdinTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description: "Writes characters to an existing unified exec session and returns recent output.",
		renderShell: "self",
		promptSnippet: "Write to an exec session.",
		parameters: WRITE_STDIN_PARAMETERS,
		async execute(_toolCallId, params) {
			const typed = parseWriteStdinParams(params);
			const command = sessions.getSessionCommand(typed.session_id);
			let result: UnifiedExecResult;
			try {
				result = await sessions.write(typed);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`write_stdin failed: ${message}`);
			}
			return {
				content: [{ type: "text", text: formatUnifiedExecResult(result, command) }],
				details: result,
				isError: result.exit_code !== undefined && result.exit_code !== 0,
			};
		},
		renderCall(args, theme, context) {
			const sessionId = typeof args.session_id === "number" ? args.session_id : "?";
			const running = context?.isPartial === true;
			if (isEmptyPoll(args)) {
				return createEmptyResultComponent();
			}
			scheduleRunningInvalidation(context, running);
			const currentElapsedMs = elapsedMs(context, running);
			const input = typeof args.chars === "string" ? args.chars : undefined;
			const snapshot = typeof sessionId === "number" ? sessions.getSessionSnapshot(sessionId) : undefined;
			const command = typeof sessionId === "number" ? sessions.getSessionCommand(sessionId) : undefined;
			return renderExecCellComponent(
				{
					kind: "write-stdin",
					status: running ? "running" : "done",
					command,
					failed: context?.isError === true,
					elapsedMs: currentElapsedMs,
					writeStdin: {
						sessionId,
						input,
						stdinOpen: snapshot?.stdinOpen,
					},
				},
				{ theme, part: "header" },
				context?.lastComponent,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context?: RenderContextLike) {
			if (isPartial) return createEmptyResultComponent();
			const state = getResultState(result);
			if (isEmptyPollRenderContext(context)) {
				return createEmptyResultComponent();
			}
			const output = renderTerminalText(state.output);
			const footer =
				state.sessionId !== undefined
					? `${theme.fg("accent", `Session ${state.sessionId} still running`)}${
							state.stdinOpen ? `${theme.fg("dim", " · ")}${theme.fg("mdLink", "tty")}` : ""
						}`
					: state.exitCode !== undefined && state.exitCode !== 0
						? theme.fg("muted", `Exit code: ${state.exitCode}`)
						: undefined;
			return renderExecCellComponent(
				{
					kind: "write-stdin",
					status: "done",
					outputBlock: {
						output,
						footer,
						options: {
							expanded,
							truncatedAbove: state.outputTruncated,
							originalTokenCount: state.originalTokenCount,
						},
					},
				},
				{ theme, part: "output" },
				context?.lastComponent,
			);
		},
	});
}
