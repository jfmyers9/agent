import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ANSWER_ENTRY,
	answerMessage,
	isBackgroundAgent,
	pendingQuestions,
	QUESTION_ENTRY,
	RESPONSE_MESSAGE,
	questionGroup,
	type Question,
	type QuestionGroup,
} from "../core/state.ts";

export type CoordinatorLookup = (sessionId: string) => { readonly rootSessionId: string } | undefined;

export class Conversation {
	private readonly listeners = new Set<(ctx: ExtensionContext) => void>();
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly coordinator: CoordinatorLookup = () => undefined,
	) {}
	onChange(listener: (ctx: ExtensionContext) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private changed(ctx: ExtensionContext): void {
		for (const listener of this.listeners) listener(ctx);
	}
	pending(ctx: ExtensionContext): QuestionGroup[] {
		return pendingQuestions(ctx.sessionManager.getBranch());
	}
	question(ctx: ExtensionContext, id: string, questions: Question[]): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const coordinator = this.coordinator(sessionId);
		if (isBackgroundAgent(ctx.sessionManager.getBranch()) || (coordinator && coordinator.rootSessionId !== sessionId))
			throw new Error("Ask your parent agent for clarification through its mailbox");
		const group = questionGroup({ version: 1, id, questions });
		if (!group) throw new Error("Questions and options must not be empty");
		if (this.pending(ctx).some((pending) => pending.id === id)) throw new Error("Question already pending");
		this.pi.appendEntry(QUESTION_ENTRY, group);
		this.changed(ctx);
	}
	answer(ctx: ExtensionContext, group: QuestionGroup, answers: string[], dismissed = false): void {
		const pending = this.pending(ctx).find((pending) => pending.id === group.id);
		if (!pending) throw new Error("This question is no longer pending");
		if (!dismissed && (answers.length !== pending.questions.length || answers.some((answer) => !answer.trim())))
			throw new Error("Answer every question before submitting");
		const answer = { version: 1 as const, id: group.id, answers: dismissed ? [] : answers, dismissed };
		this.pi.appendEntry(ANSWER_ENTRY, answer);
		try {
			this.pi.sendMessage(
				{ customType: RESPONSE_MESSAGE, content: answerMessage(pending, answer), details: answer, display: false },
				{ deliverAs: "steer", triggerTurn: true },
			);
		} finally {
			// Persistence precedes delivery: session lifecycle recovery restores a lost steering queue.
			this.changed(ctx);
		}
	}
}
