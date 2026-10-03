export type OutputNotice = { text: string; level: "error" | "warning" | "info" };
export type FormattedOutput = { text: string; notices: OutputNotice[]; changed: boolean };

const RENDER_KEYS = new Set(["highlightedRows", "highlightedSections", "highlightedDiffRows", "hashlineTag"]);
const ENVELOPE_KEYS = new Set(["content", "details", "isError"]);
const MAX_PARSE = 1_000_000;
const MAX_DEPTH = 8;

/** Only use for known failed calls: exception labels are not ordinary stdout. */
export function formatFailure(raw: string): FormattedOutput | undefined {
	const input = raw.replace(
		/^(?:[^\n]{1,120}:\n)?(?:Error: )?(?=(?:Command: |Chunk ID: |Wall time: |Total output lines: ))/,
		"",
	);
	const parsed = formatOutput(input);
	if (
		!parsed.changed ||
		!parsed.notices.some((notice) => notice.level === "error" || notice.text === "Process cancelled")
	)
		return undefined;
	// Rejected exec calls carry stderr after stdout. Keep the diagnostic in the
	// preview rather than burying it beyond the six-line output budget.
	const separator = "\n\nstderr:\n";
	const index = parsed.text.lastIndexOf(separator);
	const text =
		index < 0
			? parsed.text
			: `stderr:\n${parsed.text.slice(index + separator.length).trimEnd()}\n\n${parsed.text.slice(0, index).trimEnd()}`;
	return { ...parsed, text, changed: text !== raw };
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blocks(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every((item) => record(item) && typeof item.type === "string");
}

function envelope(value: unknown): value is Record<string, unknown> & { content: Record<string, unknown>[] } {
	return (
		record(value) &&
		blocks(value.content) &&
		(value.isError === undefined || typeof value.isError === "boolean") &&
		Object.keys(value).every((key) => ENVELOPE_KEYS.has(key))
	);
}

/** Presentation only. Unknown data is retained; callers keep raw output for expansion. */
export function formatOutput(raw: string): FormattedOutput {
	const notices: OutputNotice[] = [];
	const seen = new Set<string>();
	function notice(text: string, level: OutputNotice["level"]): void {
		const key = `${level}:${text}`;
		if (!seen.has(key)) {
			seen.add(key);
			notices.push({ text, level });
		}
	}
	function pretty(value: unknown): string {
		return JSON.stringify(value, null, 2);
	}
	function details(value: unknown, body: string): string {
		if (!record(value)) return value === undefined ? "" : pretty({ details: value });
		const unknown: Record<string, unknown> = Object.create(null);
		const unified = typeof value.chunk_id === "string" && typeof value.wall_time_seconds === "number";
		for (const [key, item] of Object.entries(value)) {
			if (RENDER_KEYS.has(key)) continue;
			if (["error", "session_error", "warning", "warnings"].includes(key)) {
				if (item !== false && item !== null && item !== "") {
					const level = key.startsWith("warn") ? "warning" : "error";
					for (const message of Array.isArray(item) ? item : [item])
						notice(
							`${key === "warnings" ? "warning" : key === "session_error" ? "Session error" : key}: ${typeof message === "string" ? message : JSON.stringify(message)}`,
							level,
						);
				}
			} else if (key === "exit_code" && typeof item === "number") {
				if (item !== 0) notice(`Process exited with code ${item}`, "error");
			} else if (
				["timed_out", "cancelled", "truncated", "output_truncated"].includes(key) &&
				typeof item === "boolean"
			) {
				if (item)
					notice(
						key === "timed_out" ? "Process timed out" : key === "cancelled" ? "Process cancelled" : "Output truncated",
						key === "timed_out" ? "error" : "warning",
					);
			} else if (["full_output_path", "fullOutputPath"].includes(key) && typeof item === "string") {
				notice(`Full output: ${item}`, "info");
			} else if (key === "process_id" && typeof item === "number") {
				if (
					value.exit_code === undefined &&
					!value.timed_out &&
					!value.cancelled &&
					!value.session_error &&
					value.terminal_state === undefined
				)
					notice(`Process running with process ID ${item}`, "info");
			} else if (unified && ["chunk_id", "wall_time_seconds", "original_token_count"].includes(key)) {
				// Duplicated transport metadata, not command output.
			} else if (unified && key === "output" && typeof item === "string" && body.includes(item)) {
				// Only discard a duplicated output field, not additional data.
			} else if (unified && key === "stdin_open" && typeof item === "boolean") {
				if (item) notice("TTY: yes", "info");
			} else {
				unknown[key] = item;
			}
		}
		return Object.keys(unknown).length ? pretty({ details: unknown }) : "";
	}
	function structured(value: unknown, depth: number): string {
		if (depth >= MAX_DEPTH) return pretty(value);
		if (envelope(value)) {
			if (value.isError === true) notice("Tool error", "error");
			const body = value.content.length === 0 ? "" : structured(value.content, depth + 1);
			return [body, details(value.details, body)].filter((part) => part !== "").join("\n");
		}
		if (blocks(value) && value.length > 0) {
			return value
				.map((block) => {
					if (
						block.type === "text" &&
						typeof block.text === "string" &&
						Object.keys(block).every((key) => ["type", "text"].includes(key))
					)
						return parse(block.text, depth + 1);
					if (block.type === "image") {
						const { data: _data, ...rest } = block;
						const extra = Object.keys(rest).some((key) => !["type", "mimeType"].includes(key));
						return `[Image output: ${typeof block.mimeType === "string" ? block.mimeType : "image"}]${extra ? `\n${pretty(rest)}` : ""}`;
					}
					return pretty(block);
				})
				.join("\n");
		}
		return pretty(value);
	}
	function shell(input: string): string | undefined {
		// Match the complete known prefix, never remove similarly named stdout lines.
		const match =
			/^(?:Command: [\s\S]*?\n)?(?:Chunk ID: [^\n]+\n)?Wall time: \d+(?:\.\d+)? seconds\n((?:(?:Process exited with code -?\d+|Process timed out|Process cancelled|Session error: [^\n]*|Process running with process ID \d+|TTY: yes|Original token count: \d+)\n)*)Output:\n/.exec(
				input,
			);
		if (!match) return undefined;
		for (const line of match[1]!.split("\n")) {
			if (!line || line === "Process exited with code 0" || line.startsWith("Original token count:")) continue;
			notice(
				line,
				/^(Process exited|Process timed out|Session error:)/.test(line)
					? "error"
					: line === "Process cancelled"
						? "warning"
						: "info",
			);
		}
		return input.slice(match[0].length);
	}
	function parse(input: string, depth: number): string {
		if (depth >= MAX_DEPTH || input.length > MAX_PARSE) return input;
		if (/…\d+ (?:tokens|chars) truncated…/.test(input)) notice("Output truncated", "warning");
		for (const match of input.matchAll(/^\[Full output: (.+?) \((?:read with offset\/limit)[^\n]*\)\]$/gm))
			notice(`Full output: ${match[1]}`, "info");
		const truncation = /^Total output lines: \d+\n\n/.exec(input);
		if (truncation) {
			const truncatedBody = shell(input.slice(truncation[0].length));
			if (truncatedBody !== undefined) {
				notice("Output truncated", "warning");
				return truncatedBody;
			}
		}
		const body = shell(input);
		if (body !== undefined) return body; // stdout/stderr are deliberately verbatim, including JSON.
		try {
			return structured(JSON.parse(input), depth + 1);
		} catch {
			// Console labels plus JSONL tool envelopes are common. Do not reinterpret ordinary lines.
			return input
				.split("\n")
				.map((line) => {
					const match = /^([^[{]*?:\s*)?([[{].*)$/.exec(line);
					if (!match) return line;
					try {
						const value: unknown = JSON.parse(match[2]!);
						if (!(blocks(value) && value.length > 0) && !envelope(value)) return line;
						return (match[1] ?? "") + structured(value, depth + 1);
					} catch {
						return line;
					}
				})
				.join("\n");
		}
	}
	const text = parse(raw, 0);
	return { text, notices, changed: text !== raw };
}
