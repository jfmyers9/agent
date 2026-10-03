import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ResponseInput } from "openai/resources/responses/responses.js";

type Message = Context["messages"][number];

interface ImageGenerationCallItem {
	type: "image_generation_call";
	id: string;
	status: string;
	result: string | null;
	revised_prompt?: string;
	artifact_result?: string;
}

interface ImageGenerationCallBlock {
	type: "image_generation_call";
	item: ImageGenerationCallItem;
}

type InternalAssistantContent = Extract<Message, { role: "assistant" }>["content"][number] | ImageGenerationCallBlock;

type TextSignaturePhase = "commentary" | "final_answer";

interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
}

function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function isImageGenerationCallBlock(block: InternalAssistantContent): block is ImageGenerationCallBlock {
	return block.type === "image_generation_call" && block.item?.type === "image_generation_call";
}

function sanitizeImageGenerationCallItem(item: unknown): ImageGenerationCallItem | undefined {
	if (!item || typeof item !== "object") return undefined;
	const candidate = item as Record<string, unknown>;
	if (candidate.type !== "image_generation_call") return undefined;
	if (typeof candidate.id !== "string" || candidate.id === "") return undefined;
	if (typeof candidate.status !== "string" || candidate.status === "") return undefined;
	if (!(typeof candidate.result === "string" || candidate.result === null)) return undefined;

	return {
		type: "image_generation_call",
		id: candidate.id,
		status: candidate.status,
		result: candidate.result,
		...(typeof candidate.revised_prompt === "string" ? { revised_prompt: candidate.revised_prompt } : {}),
		...(typeof candidate.artifact_result === "string" ? { artifact_result: candidate.artifact_result } : {}),
	};
}

function toResponsesImageGenerationCallItem(item: unknown): ImageGenerationCallItem | undefined {
	const sanitized = sanitizeImageGenerationCallItem(item);
	if (!sanitized) return undefined;
	return {
		type: sanitized.type,
		id: sanitized.id,
		status: sanitized.status,
		result: sanitized.result,
		...(sanitized.revised_prompt !== undefined ? { revised_prompt: sanitized.revised_prompt } : {}),
	};
}

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(
	content: Extract<Message, { role: "user" }> extends { content: infer T } ? Exclude<T, string> : never,
	placeholder: string,
) {
	const result: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

function downgradeUnsupportedImages(messages: Context["messages"], model: Model<Api>): Context["messages"] {
	if (model.input.includes("image")) return messages;
	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}
		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}
		return msg;
	});
}

function transformMessages(
	messages: Context["messages"],
	model: Model<Api>,
	normalizeToolCallId?: (
		id: string,
		targetModel: Model<Api>,
		source: Extract<Message, { role: "assistant" }>,
	) => string,
): Context["messages"] {
	const toolCallIdMap = new Map<string, string>();
	const imageAwareMessages = downgradeUnsupportedImages(messages, model);
	const transformed = imageAwareMessages.map((msg) => {
		if (msg.role === "user") return msg;
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			return normalizedId && normalizedId !== msg.toolCallId ? { ...msg, toolCallId: normalizedId } : msg;
		}
		if (msg.role === "assistant") {
			const assistantMsg = msg;
			const isSameModel =
				assistantMsg.provider === model.provider && assistantMsg.api === model.api && assistantMsg.model === model.id;
			const transformedContent = (assistantMsg.content as InternalAssistantContent[]).flatMap((block) => {
				if (isImageGenerationCallBlock(block)) return block;
				if (block.type === "thinking") {
					if (block.redacted) return isSameModel ? block : [];
					if (isSameModel && block.thinkingSignature) return block;
					if (!block.thinking || block.thinking.trim() === "") return [];
					return isSameModel ? block : { type: "text" as const, text: block.thinking };
				}
				if (block.type === "text") return isSameModel ? block : { type: "text" as const, text: block.text };
				if (block.type === "toolCall") {
					let normalizedToolCall = block;
					if (!isSameModel && block.thoughtSignature) {
						normalizedToolCall = { ...block };
						delete normalizedToolCall.thoughtSignature;
					}
					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(block.id, model, assistantMsg);
						if (normalizedId !== block.id) {
							toolCallIdMap.set(block.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}
					return normalizedToolCall;
				}
				return block;
			});
			return {
				...assistantMsg,
				content: transformedContent as Extract<Message, { role: "assistant" }>["content"],
			};
		}
		return msg;
	});

	const result: Context["messages"] = [];
	let pendingToolCalls: Array<
		Extract<Extract<Message, { role: "assistant" }>["content"][number], { type: "toolCall" }>
	> = [];
	let existingToolResultIds = new Set<string>();

	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length === 0) return;
		for (const toolCall of pendingToolCalls) {
			if (!existingToolResultIds.has(toolCall.id)) {
				result.push({
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				});
			}
		}
		pendingToolCalls = [];
		existingToolResultIds = new Set();
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			insertSyntheticToolResults();
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			const toolCalls = msg.content.filter((block) => block.type === "toolCall");
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}
			result.push(msg);
			continue;
		}
		if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
			continue;
		}
		if (msg.role === "user") {
			insertSyntheticToolResults();
			result.push(msg);
			continue;
		}
		result.push(msg);
	}

	insertSyntheticToolResults();

	return result;
}

function parseTextSignature(signature: string | undefined): { id: string; phase?: TextSignaturePhase } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as {
				v?: number;
				id?: string;
				phase?: TextSignaturePhase | string;
			};
			if (parsed.v === 1 && typeof parsed.id === "string") {
				return parsed.phase === "commentary" || parsed.phase === "final_answer"
					? { id: parsed.id, phase: parsed.phase }
					: { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const normalizeIdPart = (part: string) => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};
	const buildForeignResponsesItemId = (itemId: string) => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};
	const normalizeResponsesFunctionCallItemId = (itemId: string | undefined) => {
		if (!itemId) return undefined;
		const normalizedItemId = normalizeIdPart(itemId);
		return normalizedItemId.startsWith("fc_") ? normalizedItemId : normalizeIdPart(`fc_${normalizedItemId}`);
	};
	const normalizeToolCallId = (
		id: string,
		_targetModel: Model<TApi>,
		source: Extract<Message, { role: "assistant" }>,
	) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall
			? buildForeignResponsesItemId(itemId ?? "")
			: normalizeIdPart(itemId ?? "");
		if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model as Model<Api>, normalizeToolCallId as never);
	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		messages.push({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content = msg.content.map((item) =>
					item.type === "text"
						? {
								type: "input_text" as const,
								text: sanitizeSurrogates(item.text),
							}
						: {
								type: "input_image" as const,
								detail: "auto" as const,
								image_url: `data:${item.mimeType};base64,${item.data}`,
							},
				);
				if (content.length > 0) messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const isDifferentModel = msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
			let assistantBlockIndex = 0;
			for (const block of msg.content as InternalAssistantContent[]) {
				if (isImageGenerationCallBlock(block)) {
					const imageGenerationCall = toResponsesImageGenerationCallItem(block.item);
					if (imageGenerationCall) output.push(imageGenerationCall as ResponseInput[number]);
				} else if (block.type === "thinking") {
					if (block.thinkingSignature) output.push(JSON.parse(block.thinkingSignature));
				} else if (block.type === "text") {
					const parsedSignature = parseTextSignature(block.textSignature);
					const fallbackMessageId =
						assistantBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${assistantBlockIndex}`;
					let msgId = parsedSignature?.id ?? fallbackMessageId;
					if (msgId.length > 64) msgId = `msg_${shortHash(msgId)}`;
					output.push({
						type: "message",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: sanitizeSurrogates(block.text),
								annotations: [],
							},
						],
						status: "completed",
						id: msgId,
						...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
					});
					assistantBlockIndex++;
				} else if (block.type === "toolCall") {
					const [callId, itemIdRaw] = block.id.split("|");
					let itemId = normalizeResponsesFunctionCallItemId(itemIdRaw);
					if (isDifferentModel && itemId?.startsWith("fc_")) itemId = undefined;
					output.push({
						type: "function_call",
						...(itemId ? { id: itemId } : {}),
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
						...(msg.provider === model.provider &&
						msg.api === model.api &&
						msg.model === model.id &&
						block.namespace !== undefined
							? { namespace: block.namespace }
							: {}),
					} as ResponseInput[number]);
				}
			}
			if (output.length > 0) messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c) => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");
			const output =
				hasImages && model.input.includes("image")
					? [
							...(hasText
								? [
										{
											type: "input_text" as const,
											text: sanitizeSurrogates(textResult),
										},
									]
								: []),
							...msg.content
								.filter((block) => block.type === "image")
								.map((block) => ({
									type: "input_image" as const,
									detail: "auto" as const,
									image_url: `data:${block.mimeType};base64,${block.data}`,
								})),
						]
					: sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			messages.push({ type: "function_call_output", call_id: callId, output });
		}
		msgIndex++;
	}

	return messages;
}
