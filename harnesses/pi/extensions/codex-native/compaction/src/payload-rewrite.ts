import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { AUTO_COMPACT_STOP_MESSAGE } from "../../../auto-compact-resume";
import type { ResponsesCompatibleRequestPayload } from "./runtime";
import {
	compareResponsesInputParity,
	type ResponsesInputContentItem,
	type ResponsesInputItem,
	type ResponsesInputMessageItem,
	serializeMessagesToResponsesInput,
} from "./serializer";
import type { NativeCompactionEntry } from "./types";

type FreshAuthoritativePreamble = {
	instructions?: string;
	leadingInput: ResponsesInputMessageItem[];
	trailingInput: ResponsesInputMessageItem[];
};

type SerializedReplaySlice = {
	entries: SessionEntry[];
	messages: AgentMessage[];
	input: ResponsesInputItem[];
};

type NativeReplaySegments = {
	boundaryIndex: number;
	firstKeptEntryIndex: number;
	instructions?: string;
	freshPreamble: ResponsesInputMessageItem[];
	trailingPreamble: ResponsesInputMessageItem[];
	compactionSummary: ResponsesInputItem[];
	preCompactionKeptWindow: SerializedReplaySlice;
	compactedWindow: unknown[];
	postCompactionTail: SerializedReplaySlice;
	originalPiReplayInput: ResponsesInputItem[];
	replayInput: unknown[];
};

type NativeReplayPayloadRewrite = {
	ok: true;
	segments: NativeReplaySegments;
	rewrittenPayload: ResponsesCompatibleRequestPayload;
};

type NativeReplayPayloadRewriteFailureReason =
	| "compaction-boundary-not-found"
	| "first-kept-entry-not-found"
	| "unsupported-instructions"
	| "invalid-compacted-window"
	| "unexpected-compaction-after-boundary"
	| "expected-pi-replay-mismatch";

type NativeReplayPayloadRewriteFailure = {
	ok: false;
	reason: NativeReplayPayloadRewriteFailureReason;
	parity?: {
		actual: string[];
		expected: string[];
		mismatches: string[];
	};
};

type NativeReplayPayloadRewriteResult = NativeReplayPayloadRewrite | NativeReplayPayloadRewriteFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isResponsesInputContentItem(value: unknown): value is ResponsesInputContentItem {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	if (value.type === "input_text") {
		return typeof value.text === "string";
	}

	if (value.type === "input_image") {
		return value.detail === "auto" && typeof value.image_url === "string";
	}

	return false;
}

function isResponsesInputMessageRole(value: unknown): value is ResponsesInputMessageItem["role"] {
	return value === "user" || value === "developer" || value === "system";
}

function isPreambleRole(value: ResponsesInputMessageItem["role"]): value is "developer" | "system" {
	return value === "developer" || value === "system";
}

function isResponsesInputMessageItem(value: unknown): value is ResponsesInputMessageItem {
	if (!isRecord(value) || !isResponsesInputMessageRole(value.role)) {
		return false;
	}

	const { content } = value;
	return typeof content === "string" || (Array.isArray(content) && content.every(isResponsesInputContentItem));
}

function isAutoCompactStopTail(items: readonly unknown[]): boolean {
	return areEquivalentValues(items, [
		{
			role: "user",
			content: [{ type: "input_text", text: AUTO_COMPACT_STOP_MESSAGE }],
		},
	]);
}

function cloneStructuredValue(value: unknown): unknown {
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(cloneStructuredValue);
	}

	if (isRecord(value)) {
		const clone: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			clone[key] = cloneStructuredValue(nested);
		}
		return clone;
	}

	throw new Error(`Unsupported structured value: ${typeof value}`);
}

function cloneOpaqueCompactedWindow(compactedWindow: readonly unknown[]): unknown[] | undefined {
	const cloned: unknown[] = [];

	for (const item of compactedWindow) {
		if (!isRecord(item)) {
			return undefined;
		}

		try {
			cloned.push(cloneStructuredValue(item));
		} catch {
			return undefined;
		}
	}

	return cloned;
}

function cloneResponsesInputSlice(items: readonly unknown[]): ResponsesInputItem[] | undefined {
	const cloned: ResponsesInputItem[] = [];

	for (const item of items) {
		try {
			cloned.push(cloneStructuredValue(item) as ResponsesInputItem);
		} catch {
			return undefined;
		}
	}

	return cloned;
}

function areEquivalentValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}

	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}

		for (let index = 0; index < left.length; index++) {
			if (!areEquivalentValues(left[index], right[index])) {
				return false;
			}
		}

		return true;
	}

	if (isRecord(left) || isRecord(right)) {
		if (!isRecord(left) || !isRecord(right)) {
			return false;
		}

		// Provider serializers may retain optional fields as undefined. They are
		// absent on the JSON wire, so they must not invalidate an otherwise identical replay.
		const leftKeys = Object.keys(left)
			.filter((key) => left[key] !== undefined)
			.sort();
		const rightKeys = Object.keys(right)
			.filter((key) => right[key] !== undefined)
			.sort();
		if (!areEquivalentValues(leftKeys, rightKeys)) {
			return false;
		}

		for (const key of leftKeys) {
			if (!areEquivalentValues(left[key], right[key])) {
				return false;
			}
		}

		return true;
	}

	return false;
}

function isNativeCompactionContextMessage(message: AgentMessage): boolean {
	if (
		message.role === "custom" &&
		(message.customType === "codex-web-search-activity" || message.customType === "image-attach-preview")
	) {
		return false;
	}
	if (
		message.role === "assistant" &&
		message.provider === "openai-codex" &&
		message.stopReason === "error" &&
		(message.errorMessage === "WebSocket error" ||
			message.errorMessage?.startsWith("WebSocket connection error") === true)
	) {
		return false;
	}
	return true;
}

export function filterNativeCompactionContextMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.filter(isNativeCompactionContextMessage);
}

function toReplayAgentMessage(entry: SessionEntry): AgentMessage | undefined {
	let message: AgentMessage | undefined;
	if (entry.type === "message") message = entry.message;
	else if (entry.type === "branch_summary") {
		message = {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	} else if (entry.type === "compaction") {
		message = {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return message ? filterNativeCompactionContextMessages([message])[0] : undefined;
}

function isPromptEnvelopeItem(item: unknown): item is ResponsesInputMessageItem {
	return isResponsesInputMessageItem(item) && isPreambleRole(item.role);
}

function extractFreshAuthoritativePreamble(
	payload: ResponsesCompatibleRequestPayload,
): FreshAuthoritativePreamble | undefined {
	if (payload.instructions !== undefined && typeof payload.instructions !== "string") {
		return undefined;
	}

	// Developer/system items in Pi's Responses payload are prompt-level instructions,
	// not transcript entries from session history. Preserve them in the same leading
	// or trailing position that Pi authored so provider-added suffix prompts like
	// GPT-5's trailing developer "# Juice: 0 !important" survive replay unchanged.
	let leadingBoundary = 0;
	while (leadingBoundary < payload.input.length && isPromptEnvelopeItem(payload.input[leadingBoundary])) {
		leadingBoundary += 1;
	}

	let trailingBoundary = payload.input.length;
	while (trailingBoundary > leadingBoundary && isPromptEnvelopeItem(payload.input[trailingBoundary - 1])) {
		trailingBoundary -= 1;
	}

	for (let index = leadingBoundary; index < trailingBoundary; index++) {
		if (isPromptEnvelopeItem(payload.input[index])) {
			return undefined;
		}
	}

	try {
		return {
			...(typeof payload.instructions === "string" ? { instructions: payload.instructions } : {}),
			leadingInput: payload.input
				.slice(0, leadingBoundary)
				.map((item) => cloneStructuredValue(item) as ResponsesInputMessageItem),
			trailingInput: payload.input
				.slice(trailingBoundary)
				.map((item) => cloneStructuredValue(item) as ResponsesInputMessageItem),
		};
	} catch {
		return undefined;
	}
}

function collectReplayMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];

	for (const entry of entries) {
		const message = toReplayAgentMessage(entry);
		if (message) {
			messages.push(message);
		}
	}

	return messages;
}

function createCompactionSummaryAgentMessage(entry: NativeCompactionEntry): AgentMessage {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	} as AgentMessage;
}

function createReplaySlice(
	entries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
	input: readonly ResponsesInputItem[],
): SerializedReplaySlice {
	return {
		entries: [...entries],
		messages: [...messages],
		input: [...input],
	};
}

function findEntryIndexByIdBeforeBoundary(
	entries: readonly SessionEntry[],
	entryId: string,
	boundaryIndex: number,
): number | undefined {
	const index = entries.findIndex((entry, candidateIndex) => candidateIndex < boundaryIndex && entry.id === entryId);
	return index >= 0 ? index : undefined;
}

function findCompactionBoundaryIndex(entries: readonly SessionEntry[], compactionEntryId: string): number | undefined {
	const boundaryIndex = entries.findIndex((entry) => entry.id === compactionEntryId);
	return boundaryIndex >= 0 ? boundaryIndex : undefined;
}

export function serializeLiveTailToResponsesInput<TApi extends Api>(args: {
	model: Model<TApi>;
	entries: readonly SessionEntry[];
}): ResponsesInputItem[] {
	return serializeMessagesToResponsesInput(args.model, collectReplayMessages(args.entries));
}

function buildNativeReplaySegmentsInternal<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
}): NativeReplayPayloadRewriteResult {
	const boundaryIndex = findCompactionBoundaryIndex(args.branchEntries, args.compactionEntry.id);
	if (boundaryIndex === undefined) {
		return {
			ok: false,
			reason: "compaction-boundary-not-found",
		};
	}

	const firstKeptEntryIndex = findEntryIndexByIdBeforeBoundary(
		args.branchEntries,
		args.compactionEntry.firstKeptEntryId,
		boundaryIndex,
	);
	if (firstKeptEntryIndex === undefined) {
		return {
			ok: false,
			reason: "first-kept-entry-not-found",
		};
	}

	const freshPreamble = extractFreshAuthoritativePreamble(args.payload);
	if (!freshPreamble) {
		return {
			ok: false,
			reason: "unsupported-instructions",
		};
	}

	const newerCompactionEntry = args.branchEntries.slice(boundaryIndex + 1).some((entry) => entry.type === "compaction");
	if (newerCompactionEntry) {
		return {
			ok: false,
			reason: "unexpected-compaction-after-boundary",
		};
	}

	const compactedWindow = cloneOpaqueCompactedWindow(args.compactionEntry.details.compactedWindow);
	if (!compactedWindow) {
		return {
			ok: false,
			reason: "invalid-compacted-window",
		};
	}

	const preCompactionEntries = args.branchEntries.slice(firstKeptEntryIndex, boundaryIndex);
	const postCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
	const preCompactionKeptMessages = collectReplayMessages(preCompactionEntries);
	const postCompactionTailMessages = collectReplayMessages(postCompactionEntries);
	const compactionSummaryMessage = createCompactionSummaryAgentMessage(args.compactionEntry);
	const serializedPiHistoryInput = serializeMessagesToResponsesInput(args.model, [
		compactionSummaryMessage,
		...preCompactionKeptMessages,
		...postCompactionTailMessages,
	]);
	const freshPreambleCount = freshPreamble.leadingInput.length;
	const trailingPreambleCount = freshPreamble.trailingInput.length;
	const actualHistoryEnd = args.payload.input.length - trailingPreambleCount;
	const actualHistory = args.payload.input.slice(freshPreambleCount, actualHistoryEnd);
	const expectedHistoryPrefix = actualHistory.slice(0, serializedPiHistoryInput.length);
	const rawTransientHistoryTail = actualHistory.slice(serializedPiHistoryInput.length);
	const transientHistoryTail =
		rawTransientHistoryTail.length === 0 || isAutoCompactStopTail(rawTransientHistoryTail)
			? cloneResponsesInputSlice(rawTransientHistoryTail)
			: undefined;

	if (
		actualHistory.length < serializedPiHistoryInput.length ||
		!areEquivalentValues(expectedHistoryPrefix, serializedPiHistoryInput) ||
		!transientHistoryTail
	) {
		const originalPiReplayInput: ResponsesInputItem[] = [
			...freshPreamble.leadingInput,
			...serializedPiHistoryInput,
			...freshPreamble.trailingInput,
		];
		const parity = compareResponsesInputParity(args.payload.input, originalPiReplayInput);
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
			parity: {
				actual: parity.actual,
				expected: parity.expected,
				mismatches: parity.mismatches,
			},
		};
	}

	const originalPiReplayInput: ResponsesInputItem[] = [
		...freshPreamble.leadingInput,
		...serializedPiHistoryInput,
		...transientHistoryTail,
		...freshPreamble.trailingInput,
	];

	const compactionSummaryCount = serializeMessagesToResponsesInput(args.model, [compactionSummaryMessage]).length;
	const preCompactionKeptCount = serializeMessagesToResponsesInput(args.model, preCompactionKeptMessages).length;
	const tailStartIndex = freshPreambleCount + compactionSummaryCount + preCompactionKeptCount;
	const tailEndIndex = args.payload.input.length - trailingPreambleCount;
	const actualCompactionSummary = cloneResponsesInputSlice(
		args.payload.input.slice(freshPreambleCount, freshPreambleCount + compactionSummaryCount),
	);
	const actualPreCompactionKeptWindow = cloneResponsesInputSlice(
		args.payload.input.slice(
			freshPreambleCount + compactionSummaryCount,
			freshPreambleCount + compactionSummaryCount + preCompactionKeptCount,
		),
	);
	const actualPostCompactionTail = cloneResponsesInputSlice(args.payload.input.slice(tailStartIndex, tailEndIndex));
	if (!actualCompactionSummary || !actualPreCompactionKeptWindow || !actualPostCompactionTail) {
		return {
			ok: false,
			reason: "expected-pi-replay-mismatch",
		};
	}

	const preCompactionKeptWindow = createReplaySlice(
		preCompactionEntries,
		preCompactionKeptMessages,
		actualPreCompactionKeptWindow,
	);
	const postCompactionTail = createReplaySlice(
		postCompactionEntries,
		postCompactionTailMessages,
		actualPostCompactionTail,
	);

	return {
		ok: true,
		segments: {
			boundaryIndex,
			firstKeptEntryIndex,
			instructions: freshPreamble.instructions,
			freshPreamble: freshPreamble.leadingInput,
			trailingPreamble: freshPreamble.trailingInput,
			compactionSummary: actualCompactionSummary,
			preCompactionKeptWindow,
			compactedWindow,
			postCompactionTail,
			originalPiReplayInput,
			replayInput: [
				...freshPreamble.leadingInput,
				...compactedWindow,
				...actualPostCompactionTail,
				...freshPreamble.trailingInput,
			],
		},
		rewrittenPayload: {
			...args.payload,
			...(freshPreamble.instructions !== undefined ? { instructions: freshPreamble.instructions } : {}),
			input: [
				...freshPreamble.leadingInput,
				...compactedWindow,
				...actualPostCompactionTail,
				...freshPreamble.trailingInput,
			],
		},
	};
}

export function rewriteResponsesPayloadWithNativeReplay<TApi extends Api>(args: {
	model: Model<TApi>;
	payload: ResponsesCompatibleRequestPayload;
	branchEntries: readonly SessionEntry[];
	compactionEntry: NativeCompactionEntry;
}): NativeReplayPayloadRewriteResult {
	return buildNativeReplaySegmentsInternal(args);
}
