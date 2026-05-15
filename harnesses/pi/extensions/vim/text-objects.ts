export type TextObjectKind = "i" | "a";

export type TextObjectRange = {
	startAbs: number;
	endAbs: number;
};

export type WordTextObjectClass = "word" | "WORD";

export type DelimiterSpec = {
	type: "quote" | "bracket";
	open: string;
	close: string;
};

function normalizeCount(count: number): number {
	if (!Number.isFinite(count) || count < 1) return 1;
	return Math.floor(count);
}

function clampCursorCol(line: string, cursorCol: number): number {
	if (line.length === 0) return 0;
	if (!Number.isFinite(cursorCol)) return 0;

	const normalized = Math.trunc(cursorCol);
	return Math.max(0, Math.min(normalized, line.length - 1));
}

function clampCursorAbs(text: string, cursorAbs: number): number {
	if (text.length === 0) return 0;
	if (!Number.isFinite(cursorAbs)) return 0;

	const normalized = Math.trunc(cursorAbs);
	return Math.max(0, Math.min(normalized, text.length - 1));
}

function findLogicalLineBounds(line: string, cursorCol: number): { start: number; end: number } {
	if (line.length === 0) return { start: 0, end: 0 };

	const previousSearchStart = line[cursorCol] === "\n" ? cursorCol - 1 : cursorCol;
	const start = line.lastIndexOf("\n", previousSearchStart) + 1;
	const nextNewline = line.indexOf("\n", cursorCol);

	return {
		start,
		end: nextNewline === -1 ? line.length : nextNewline,
	};
}

function findCurrentLineBounds(text: string, cursorAbs: number): { startAbs: number; endAbs: number } {
	const cursor = clampCursorAbs(text, cursorAbs);
	const bounds = findLogicalLineBounds(text, cursor);

	return {
		startAbs: bounds.start,
		endAbs: bounds.end,
	};
}

function isWordTextObjectChar(ch: string | undefined, semanticClass: WordTextObjectClass): boolean {
	if (ch === undefined) return false;
	if (semanticClass === "WORD") return !/\s/.test(ch);
	return /\w/.test(ch);
}

function isWhitespace(ch: string | undefined): boolean {
	return ch !== undefined && /\s/.test(ch);
}

export function normalizeDelimiterKey(key: string): DelimiterSpec | null {
	if (key === '"' || key === "'" || key === "`") {
		return {
			type: "quote",
			open: key,
			close: key,
		};
	}

	if (key === "(" || key === ")" || key === "b") {
		return {
			type: "bracket",
			open: "(",
			close: ")",
		};
	}

	if (key === "[" || key === "]") {
		return {
			type: "bracket",
			open: "[",
			close: "]",
		};
	}

	if (key === "{" || key === "}" || key === "B") {
		return {
			type: "bracket",
			open: "{",
			close: "}",
		};
	}

	return null;
}

export function isEscapedDelimiter(text: string, index: number): boolean {
	if (!Number.isInteger(index) || index <= 0 || index >= text.length) return false;

	let backslashCount = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
		backslashCount++;
	}

	return backslashCount % 2 === 1;
}

export function resolveQuoteObjectRange(
	text: string,
	cursorAbs: number,
	kind: TextObjectKind,
	quote: string,
): TextObjectRange | null {
	const spec = normalizeDelimiterKey(quote);
	if (spec?.type !== "quote") return null;

	const cursor = clampCursorAbs(text, cursorAbs);
	const bounds = findCurrentLineBounds(text, cursor);
	if (bounds.startAbs >= bounds.endAbs) return null;

	let openIndex: number | null = null;
	let bestPair: { open: number; close: number } | null = null;

	for (let index = bounds.startAbs; index < bounds.endAbs; index++) {
		if (text[index] !== quote || isEscapedDelimiter(text, index)) continue;

		if (openIndex === null) {
			openIndex = index;
			continue;
		}

		const closeIndex = index;
		if (openIndex <= cursor && cursor <= closeIndex) {
			if (bestPair === null || closeIndex - openIndex < bestPair.close - bestPair.open) {
				bestPair = { open: openIndex, close: closeIndex };
			}
		}
		openIndex = null;
	}

	if (bestPair === null) return null;

	if (kind === "i") {
		return {
			startAbs: bestPair.open + 1,
			endAbs: bestPair.close,
		};
	}

	return {
		startAbs: bestPair.open,
		endAbs: bestPair.close + 1,
	};
}

export function resolveBracketObjectRange(
	text: string,
	cursorAbs: number,
	kind: TextObjectKind,
	open: string,
	close: string,
): TextObjectRange | null {
	if (open.length !== 1 || close.length !== 1 || open === close) return null;

	const cursor = clampCursorAbs(text, cursorAbs);
	const openStack: number[] = [];
	let bestPair: { open: number; close: number } | null = null;

	for (let index = 0; index < text.length; index++) {
		const ch = text[index];

		if (ch === open) {
			openStack.push(index);
			continue;
		}

		if (ch !== close) continue;

		const openIndex = openStack.pop();
		if (openIndex === undefined) continue;

		if (openIndex <= cursor && cursor <= index) {
			if (bestPair === null || index - openIndex < bestPair.close - bestPair.open) {
				bestPair = { open: openIndex, close: index };
			}
		}
	}

	if (bestPair === null) return null;

	if (kind === "i") {
		return {
			startAbs: bestPair.open + 1,
			endAbs: bestPair.close,
		};
	}

	return {
		startAbs: bestPair.open,
		endAbs: bestPair.close + 1,
	};
}

export function resolveDelimitedTextObjectRange(
	text: string,
	cursorAbs: number,
	kind: TextObjectKind,
	key: string,
): TextObjectRange | null {
	const spec = normalizeDelimiterKey(key);
	if (spec === null) return null;

	if (spec.type === "quote") {
		return resolveQuoteObjectRange(text, cursorAbs, kind, spec.open);
	}

	if (spec.type === "bracket") {
		return resolveBracketObjectRange(text, cursorAbs, kind, spec.open, spec.close);
	}

	return null;
}

export function resolveWordTextObjectRange(
	line: string,
	lineStartAbs: number,
	cursorCol: number,
	kind: TextObjectKind,
	count: number = 1,
	semanticClass: WordTextObjectClass = "word",
): TextObjectRange | null {
	if (line.length === 0) return null;

	const cursor = clampCursorCol(line, cursorCol);
	const bounds = findLogicalLineBounds(line, cursor);
	if (bounds.start >= bounds.end) return null;

	const hasWordChar = (idx: number) =>
		idx >= bounds.start && idx < bounds.end && isWordTextObjectChar(line[idx], semanticClass);

	let col = Math.max(bounds.start, Math.min(cursor, bounds.end - 1));

	if (!hasWordChar(col)) {
		let right = col;
		while (right < bounds.end && !hasWordChar(right)) right++;

		if (right < bounds.end) {
			col = right;
		} else {
			let left = Math.min(col, bounds.end - 1);
			while (left >= bounds.start && !hasWordChar(left)) left--;
			if (left < bounds.start) return null;
			col = left;
		}
	}

	let start = col;
	while (start > bounds.start && hasWordChar(start - 1)) start--;

	let end = col + 1;
	while (end < bounds.end && hasWordChar(end)) end++;

	let remaining = normalizeCount(count) - 1;
	while (remaining > 0) {
		let nextWordStart = end;
		while (nextWordStart < bounds.end && !hasWordChar(nextWordStart)) nextWordStart++;
		if (nextWordStart >= bounds.end) break;

		let nextWordEnd = nextWordStart + 1;
		while (nextWordEnd < bounds.end && hasWordChar(nextWordEnd)) nextWordEnd++;

		end = nextWordEnd;
		remaining--;
	}

	if (kind === "a") {
		let aroundEnd = end;
		while (aroundEnd < bounds.end && isWhitespace(line[aroundEnd])) aroundEnd++;

		if (aroundEnd > end) {
			end = aroundEnd;
		} else {
			while (start > bounds.start && isWhitespace(line[start - 1])) start--;
		}
	}

	return {
		startAbs: lineStartAbs + start,
		endAbs: lineStartAbs + end,
	};
}
