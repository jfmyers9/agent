export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
export const DEFAULT_MAX_OUTPUT_LINE_CHARS = 400;
export const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;

export function approxTokenCount(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function safeSliceByBytes(text: string, start: number, end?: number): string {
	const buffer = Buffer.from(text, "utf8");
	let safeStart = Math.min(buffer.length, Math.max(0, start));
	let safeEnd = Math.min(buffer.length, Math.max(safeStart, end ?? buffer.length));
	while (safeStart < buffer.length && (buffer[safeStart]! & 0xc0) === 0x80) safeStart += 1;
	while (safeEnd > safeStart && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1;
	return buffer.subarray(safeStart, safeEnd).toString("utf8");
}

export function capHeadTail(text: string, maxBytes: number): string {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) return text;
	const headBudget = Math.floor(maxBytes / 2);
	const tailBudget = maxBytes - headBudget;
	return safeSliceByBytes(text, 0, headBudget) + safeSliceByBytes(text, totalBytes - tailBudget);
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function truncateMiddleWithTokenBudget(text: string, maxTokens: number): string {
	const maxBytes = maxTokens * 4;
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) return text;
	if (maxBytes <= 0) return `…${approxTokenCount(text)} tokens truncated…`;
	const leftBudget = Math.floor(maxBytes / 2);
	const rightBudget = maxBytes - leftBudget;
	const prefix = safeSliceByBytes(text, 0, leftBudget);
	const suffix = safeSliceByBytes(text, totalBytes - rightBudget);
	const removedTokens = Math.ceil(Math.max(0, totalBytes - maxBytes) / 4);
	return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}

function truncateLineMiddle(line: string, maxChars: number): string {
	if (line.length <= maxChars) return line;
	let marker = `…${line.length - maxChars} chars truncated…`;
	marker = `…${line.length - Math.max(0, maxChars - marker.length)} chars truncated…`;
	const budget = Math.max(0, maxChars - marker.length);
	const headBudget = Math.ceil(budget / 2);
	const tailBudget = Math.floor(budget / 2);
	return `${line.slice(0, headBudget)}${marker}${line.slice(line.length - tailBudget)}`;
}

export function truncateLongLines(
	text: string,
	maxChars = DEFAULT_MAX_OUTPUT_LINE_CHARS,
): { output: string; output_truncated?: boolean } {
	let changed = false;
	const output = text
		.split("\n")
		.map((line) => {
			const truncated = truncateLineMiddle(line, maxChars);
			if (truncated !== line) changed = true;
			return truncated;
		})
		.join("\n");
	return changed ? { output, output_truncated: true } : { output };
}

export function formattedTruncateText(text: string): { output: string; output_truncated?: boolean } {
	const limitedLines = truncateLongLines(text);
	const output = limitedLines.output;
	if (!limitedLines.output_truncated && Buffer.byteLength(output, "utf8") <= DEFAULT_MAX_OUTPUT_TOKENS * 4) {
		return { output };
	}
	const truncated =
		Buffer.byteLength(output, "utf8") > DEFAULT_MAX_OUTPUT_TOKENS * 4
			? truncateMiddleWithTokenBudget(output, DEFAULT_MAX_OUTPUT_TOKENS)
			: output;
	return {
		output: `Total output lines: ${lineCount(text)}\n\n${truncateLongLines(truncated).output}`,
		output_truncated: true,
	};
}
