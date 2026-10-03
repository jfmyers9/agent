import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const QUESTION_ENTRY = "pi-conversation/question";
export const ANSWER_ENTRY = "pi-conversation/answer";
export const RESPONSE_MESSAGE = "pi-conversation/response";
export interface Question {
	title: string;
	options?: string[];
}
export interface QuestionGroup {
	version: 1;
	id: string;
	questions: Question[];
}
export interface Answer {
	version: 1;
	id: string;
	answers: string[];
	dismissed: boolean;
}
// type-boundary: Pi session custom entries are external data; validate persisted questions and answers before rendering or delivery.
type EntryValue = unknown;
function record(value: EntryValue): value is Record<string, EntryValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function questionGroup(value: EntryValue): QuestionGroup | undefined {
	if (!record(value) || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.questions)) return;
	const questions: Question[] = [];
	for (const item of value.questions) {
		if (!record(item) || typeof item.title !== "string" || !item.title.trim()) return;
		const options = item.options;
		if (
			options !== undefined &&
			(!Array.isArray(options) ||
				!options.length ||
				!options.every((option) => typeof option === "string" && option.trim()))
		)
			return;
		questions.push({ title: item.title, ...(options ? { options: options as string[] } : {}) });
	}
	return questions.length ? { version: 1, id: value.id, questions } : undefined;
}
export function answerData(value: EntryValue): Answer | undefined {
	if (
		!record(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		typeof value.dismissed !== "boolean" ||
		!Array.isArray(value.answers) ||
		!value.answers.every((answer) => typeof answer === "string")
	)
		return;
	return { version: 1, id: value.id, dismissed: value.dismissed, answers: value.answers as string[] };
}
export function pendingQuestions(entries: readonly SessionEntry[]): QuestionGroup[] {
	const pending = new Map<string, QuestionGroup>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === QUESTION_ENTRY) {
			const group = questionGroup(entry.data);
			if (group) pending.set(group.id, group);
		}
		if (entry.customType === ANSWER_ENTRY) {
			const answer = answerData(entry.data);
			if (answer) pending.delete(answer.id);
		}
	}
	return [...pending.values()];
}
export function isBackgroundAgent(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "session.identity/v1" &&
			record(entry.data) &&
			typeof entry.data.agentName === "string" &&
			entry.data.agentName !== "/root",
	);
}

export function answerMessage(group: QuestionGroup, answer: Answer): string {
	const body = answer.dismissed
		? "Dismissed without an answer; this is not approval."
		: group.questions.map((question, index) => `${question.title}\n${answer.answers[index]}`).join("\n\n");
	return `[Response to question ${group.id}]\n${body}`;
}

/** Recover submitted answers if the process stopped before Pi persisted its steering queue. */
export function undeliveredRecords(entries: readonly SessionEntry[]): { group: QuestionGroup; answer: Answer }[] {
	const groups = new Map<string, QuestionGroup>();
	const answers = new Map<string, Answer>();
	const delivered = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === QUESTION_ENTRY) {
			const group = questionGroup(entry.data);
			if (group) groups.set(group.id, group);
		}
		if (entry.type === "custom" && entry.customType === ANSWER_ENTRY) {
			const answer = answerData(entry.data);
			if (answer) answers.set(answer.id, answer);
		}
		if (entry.type === "message" && entry.message.role === "user") {
			const text =
				typeof entry.message.content === "string"
					? entry.message.content
					: entry.message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			for (const id of answers.keys()) if (text.startsWith(`[Response to question ${id}]\n`)) delivered.add(id);
		}
		if (entry.type === "custom_message" && entry.customType === RESPONSE_MESSAGE) {
			const answer = answerData(entry.details);
			if (answer) delivered.add(answer.id);
		}
	}
	return [...answers.values()].flatMap((answer) => {
		const group = groups.get(answer.id);
		return group && !delivered.has(answer.id) ? [{ group, answer }] : [];
	});
}

export function undeliveredAnswers(entries: readonly SessionEntry[]): string[] {
	return undeliveredRecords(entries).map(({ group, answer }) => answerMessage(group, answer));
}
