import { highlightCode, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatFailure, formatOutput } from "./codemode-output";

type Renderers = Pick<ToolDefinition, "renderCall" | "renderResult">;
type Resolver = (name: string, next: () => Renderers | undefined) => Renderers | undefined;
type Call = { name: string; args: string; status: string; error?: string; durationMs?: number; cost?: number };
type Notice = { text: string; level: "error" | "warning" | "info" };
const HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function inline(value: string): string {
	return stripTerminalSequences(value).replace(/\s+/g, " ").trim();
}

/** Pi stores only a 200-character argument preview; incomplete JSON is normal. */
function argument(args: string, key: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(args);
		if (record(parsed)) {
			const value = parsed[key];
			if (typeof value === "string" || typeof value === "number") return String(value);
		}
	} catch {
		/* Read only a quoted value prefix below, never execute or guess arguments. */
	}
	const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(args);
	if (!match) return undefined;
	const tail = args.slice(match.index + match[0].length);
	let encoded = "";
	for (let i = 0; i < tail.length; i++) {
		const ch = tail[i];
		if (ch === '"') break;
		if (ch === "\\") {
			const escaped = tail[++i];
			if (!escaped) break;
			if (escaped === "u") {
				const hex = tail.slice(i + 1, i + 5);
				if (!/^[0-9a-f]{4}$/i.test(hex)) break;
				encoded += `\\u${hex}`;
				i += 4;
			} else if ('"\\/bfnrt'.includes(escaped)) encoded += `\\${escaped}`;
			else break;
		} else if (ch.charCodeAt(0) >= 32) encoded += ch;
	}
	try {
		return JSON.parse(`"${encoded}"`) as string;
	} catch {
		return undefined;
	}
}

export function summarizeCall(call: Pick<Call, "name" | "args">): { label: string; detail: string } {
	const arg = (key: string) => argument(call.args, key);
	const path = arg("path");
	switch (call.name) {
		case "read":
			return { label: "Read", detail: path ?? "" };
		case "search":
			return { label: "Search", detail: [arg("pattern"), path].filter(Boolean).join(" · ") };
		case "exec_command":
		case "bash":
			return { label: "Run", detail: arg("cmd") ?? arg("command") ?? "" };
		case "write_stdin":
			return { label: "Continue process", detail: arg("process_id") ?? "" };
		case "apply_patch": {
			const patch = arg("input") ?? "";
			const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]);
			return { label: "Patch", detail: files.length ? files.join(", ") : "" };
		}
		case "write":
		case "edit":
			return { label: call.name === "write" ? "Write" : "Edit", detail: path ?? "" };
		case "skill":
			return { label: "Load skill", detail: arg("name") ?? "" };
		default:
			return { label: call.name, detail: path ?? arg("query") ?? arg("name") ?? arg("libraryName") ?? "" };
	}
}

function duration(ms: number | undefined): string {
	if (ms === undefined || ms < 100) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

interface View {
	calls: Call[];
	output: string;
	raw: string;
	notices: Notice[];
	expanded: boolean;
	partial: boolean;
	isError: boolean;
}

/** Semantic label is also consumed by the existing transcript folding extension. */
class CodeModeResult implements Component {
	private cache = new Map<number, string[]>();
	private readonly summaries: Map<Call, ReturnType<typeof summarizeCall>>;
	constructor(
		private readonly view: View,
		private readonly theme: Theme,
	) {
		this.summaries = new Map(view.calls.map((call) => [call, summarizeCall(call)]));
	}
	getActivityLabel(): string {
		const { calls, notices } = this.view;
		const failed = notices.some((notice) => notice.level === "error") || this.view.isError;
		const warning = notices.some((notice) => notice.level === "warning");
		const call = calls.find((call) => call.status === "error" || call.status === "cancelled") ?? calls.at(-1);
		if (!call)
			return failed
				? "Code mode failed"
				: warning
					? "Code output · warnings"
					: this.view.partial
						? "Running code"
						: "Code output";
		const { label, detail } = this.summaries.get(call)!;
		return `${failed ? "Failed · " : warning ? "Warning · " : ""}${label}${detail ? ` · ${truncateToWidth(inline(detail), 100, "…")}` : ""}${calls.length > 1 ? ` · ${calls.length} operations` : ""}`;
	}
	invalidate(): void {
		this.cache.clear();
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		const cached = this.cache.get(width);
		if (cached) return cached;
		const { calls, output, raw, notices, expanded, partial, isError } = this.view;
		const theme = this.theme;
		const rows: string[] = [];
		const line = (value: string) => rows.push(truncateToWidth(value, width, "…"));
		const block = (value: string, tone: "toolOutput" | "muted" | "error" | "warning") =>
			new Text(theme.fg(tone, value), 0, 0)
				.render(Math.max(1, width - 2))
				.map((row) => truncateToWidth(`  ${row}`, width, "…"));
		const shown = expanded ? calls : calls.slice(-5);
		const outputFailed = isError || notices.some((notice) => notice.level === "error");
		const outputWarning = notices.some((notice) => notice.level === "warning");
		if (shown.length < calls.length) line(theme.fg("muted", `  … ${calls.length - shown.length} earlier operations`));
		for (const call of shown) {
			const { label, detail } = this.summaries.get(call)!;
			const failed = call.status === "error" || call.status === "cancelled" || (calls.length === 1 && outputFailed);
			const marker = failed
				? theme.fg("error", "✗")
				: call.status === "running"
					? theme.fg("warning", "…")
					: outputFailed
						? theme.fg("muted", "·")
						: outputWarning
							? theme.fg("warning", "!")
							: theme.fg("success", "✓");
			const elapsed = duration(call.durationMs);
			const suffix = elapsed ? theme.fg("dim", `  ${elapsed}`) : "";
			// No wrapped JSON or byte-based slicing: one width-aware operation per row.
			const body = `${marker} ${theme.fg("toolTitle", theme.bold(label))}${detail ? ` ${theme.fg("muted", inline(detail))}` : ""}`;
			line(truncateToWidth(body, Math.max(1, width - visibleWidth(suffix)), "…") + suffix);
		}
		if (!calls.length)
			line(
				theme.fg(
					outputFailed ? "error" : partial || outputWarning ? "warning" : "muted",
					outputFailed
						? "✗ Script failed"
						: partial
							? "… Running script"
							: outputWarning
								? "! Script completed with warnings"
								: "✓ Script completed",
				),
			);
		const unique = [...new Map(notices.map((notice) => [notice.text, notice])).values()];
		for (const notice of unique) {
			const marker = notice.level === "error" ? "✗" : notice.level === "warning" ? "!" : "↳";
			const tone = notice.level === "info" ? "muted" : notice.level;
			const noticeRows = block(`${marker} ${notice.text}`, tone);
			rows.push(...(expanded ? noticeRows : noticeRows.slice(0, 6)));
			if (!expanded && noticeRows.length > 6) line(theme.fg("muted", "  … expand to inspect full diagnostic"));
		}
		if (output.trim()) {
			const outputRows = block(output, "toolOutput");
			rows.push("");
			rows.push(...(expanded ? outputRows : outputRows.slice(0, 6)));
			if (!expanded && outputRows.length > 6)
				line(theme.fg("muted", `  … ${outputRows.length - 6} more lines · expand to inspect`));
		}
		if (expanded && calls.length) {
			rows.push("");
			line(theme.fg("muted", "Argument previews"));
			for (const call of calls) {
				line(theme.fg("toolTitle", call.name));
				let args = call.args;
				try {
					args = JSON.stringify(JSON.parse(args), null, 2);
				} catch {
					/* Native preview may be truncated. */
				}
				rows.push(...block(args, "muted"));
			}
		}
		if (expanded && raw.trim() && raw !== output) {
			rows.push("");
			line(theme.fg("muted", "Original output"));
			rows.push(...block(raw, "muted"));
		}
		this.cache.set(width, rows);
		return rows;
	}
}

export function codeModeRenderers(native?: Renderers): Renderers {
	return {
		renderCall(args, theme, context) {
			if (context.expanded && native?.renderCall)
				return native.renderCall(args, theme, { ...context, lastComponent: undefined });
			if (context.expanded && record(args) && typeof args.code === "string")
				return new Text(
					`${theme.fg("muted", "JavaScript")}\n${highlightCode(args.code, "javascript").join("\n")}`,
					0,
					0,
				);
			// The operation rows identify completed/running work; avoid a redundant Code Mode heading.
			return new Text("", 0, 0);
		},
		renderResult(result, options, theme, context) {
			const details = record(result.details) ? result.details : {};
			const calls: Call[] = Array.isArray(details.calls)
				? details.calls.filter(
						(call: unknown): call is Call =>
							record(call) &&
							typeof call.name === "string" &&
							typeof call.args === "string" &&
							typeof call.status === "string",
					)
				: [];
			const blocks = result.content
				.filter((block) => block.type === "text" && !HEADER.test(block.text))
				.map((block) => (block.type === "text" ? block.text : ""));
			// Pi emits errors as a separate block. Source files/logs can contain the
			// same words; never turn normal printed text into a failure.
			const scriptErrors = context.isError ? blocks.filter((block) => block.startsWith("Script error:\n")) : [];
			const failedCalls = calls.filter((call) => call.status === "error" || call.status === "cancelled");
			const formatted = blocks.map((block) => {
				const error = scriptErrors.includes(block);
				const failure =
					error || failedCalls.length
						? formatFailure(error ? block.slice("Script error:\n".length) : block)
						: undefined;
				return { block, failure, part: failure ?? (error ? undefined : formatOutput(block)) };
			});
			const parts = formatted.flatMap(({ part }) => (part ? [part] : []));
			const notices: Notice[] = parts.flatMap((part) => part.notices);
			for (const call of failedCalls) {
				// Native call errors may be truncated previews of a complete printed
				// exception. Prefer that complete block, never repeat the transport dump.
				const prefix = call.error?.replace(/(?:\.\.\.|…)$/, "");
				if (prefix && formatted.some(({ block, failure }) => failure && block.includes(prefix))) continue;
				const failure = call.error ? formatFailure(call.error) : undefined;
				if (failure) {
					parts.push(failure);
					notices.push(...failure.notices);
				} else if (!call.error || !scriptErrors.some((error) => error.includes(call.error!)))
					notices.push({ text: `${summarizeCall(call).label}: ${call.error ?? call.status}`, level: "error" });
			}
			for (const { block, failure } of formatted)
				if (scriptErrors.includes(block) && !failure) notices.push({ text: block.trim(), level: "error" });
			const raw = [
				...blocks,
				...failedCalls.flatMap((call) =>
					call.error && !blocks.some((block) => block.includes(call.error!.replace(/(?:\.\.\.|…)$/, "")))
						? [call.error]
						: [],
				),
			].join("\n\n");
			const output = parts
				.map((part) => part.text)
				.filter(Boolean)
				.join("\n\n");
			if (notices.some((notice) => notice.level === "error" && notice.text !== "Tool error")) {
				for (let i = notices.length - 1; i >= 0; i--) if (notices[i]!.text === "Tool error") notices.splice(i, 1);
			}
			if (context.isError && !notices.some((notice) => notice.level === "error"))
				notices.push({ text: "Script failed — expand to inspect the original output", level: "error" });
			if (typeof details.fullOutputPath === "string")
				notices.push({ text: `Full output: ${details.fullOutputPath}`, level: "info" });
			const images = result.content.filter((block) => block.type === "image");
			if (images.length && !context.showImages)
				notices.push({
					text: `${images.length} image${images.length === 1 ? "" : "s"} · enable images to view`,
					level: "info",
				});
			const cost = calls.reduce((sum, call) => sum + (typeof call.cost === "number" ? call.cost : 0), 0);
			if (cost > 0) notices.push({ text: `Model calls: $${cost.toPrecision(3)}`, level: "info" });
			return new CodeModeResult(
				{
					calls,
					raw,
					output,
					notices,
					expanded: options.expanded,
					partial: options.isPartial,
					isError: context.isError,
				},
				theme,
			);
		},
	};
}

/** The renderer hook is newer than some Pi 1.0 installations. Never replace execution. */
export function installCodeModeRenderer(pi: ExtensionAPI): void {
	const compatible = pi as ExtensionAPI & { registerToolRenderer?: (resolver: Resolver) => void };
	compatible.registerToolRenderer?.((name, next) => (name === "codemode" ? codeModeRenderers(next()) : next()));
}
