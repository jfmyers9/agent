// Question-only adaptation of luan/agents pi-conversation at ad0bff62; see LICENSE.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ANSWER_ENTRY, answerData, answerMessage, RESPONSE_MESSAGE, undeliveredRecords } from "./core/state.ts";
import { Conversation, type CoordinatorLookup } from "./runtime/conversation.ts";
import { ConversationUI } from "./ui/questions.ts";
import { answerRpcQuestions } from "./ui/rpc-questions.ts";

export default async function asyncQuestions(pi: ExtensionAPI): Promise<void> {
	// Match the existing subagents wrapper: the pinned SDK does not re-export its coordinator.
	const sdk = import.meta.resolve("@luan.sh/pi-subagents");
	const { getCoordinatorForSession } = (await import(new URL("./runtime/coordinator.ts", sdk).href)) as {
		getCoordinatorForSession: CoordinatorLookup;
	};
	const conversation = new Conversation(pi, getCoordinatorForSession);
	const ui = new ConversationUI(conversation);
	let generation = 0;
	let dialog: AbortController | undefined;
	const reset = () => {
		generation++;
		dialog?.abort();
		dialog = undefined;
		ui.dispose();
	};
	const open = async (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") {
			ui.focus(ctx);
			return;
		}
		if (ctx.mode !== "rpc" || !ctx.hasUI || dialog) return;
		const current = generation;
		const controller = new AbortController();
		dialog = controller;
		try {
			await answerRpcQuestions(ctx, conversation, controller.signal, () => current === generation);
		} finally {
			if (dialog === controller) dialog = undefined;
		}
	};
	const refresh = (ctx: ExtensionContext) => {
		ui.update(ctx);
		if (ctx.mode === "rpc" && ctx.hasUI && conversation.pending(ctx).length)
			void open(ctx).catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
	};
	conversation.onChange(refresh);
	pi.registerTool({
		name: "request_user_input_async",
		exposure: "model-only",
		label: "Ask user asynchronously",
		description:
			"Ask concise questions for missing information, preferences, constraints, clarification, or approval. Returns immediately; replies arrive asynchronously. Suggested options always allow a free-text alternative. No option is automatically submitted.",
		promptSnippet: "Ask questions without blocking independent work; answers arrive through steering.",
		promptGuidelines: [
			"Use request_user_input_async when independent work can continue while awaiting clarification. Use ask_user for multi-select or preview questions.",
			"Do not assume an unanswered or dismissed question grants approval. Wait for an explicit answer before taking the dependent action; continue unrelated authorized work.",
			"Child agents must ask their parent through its mailbox, not question the user directly.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					title: Type.String({ minLength: 1 }),
					options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
				}),
				{ minItems: 1, maxItems: 3 },
			),
		}),
		async execute(id, args, _signal, _update, ctx) {
			conversation.question(ctx, id, args.questions);
			return {
				content: [{ type: "text", text: JSON.stringify({ accepted: true, id }) }],
				details: { accepted: true, id },
			};
		},
	});
	pi.registerCommand("questions", {
		description: "Answer pending questions; /questions dismiss dismisses the oldest group",
		handler: async (args, ctx) => {
			if (args.trim() === "dismiss") {
				const group = conversation.pending(ctx)[0];
				if (group) conversation.answer(ctx, group, [], true);
			} else await open(ctx);
		},
	});
	pi.registerEntryRenderer(ANSWER_ENTRY, (entry, _options, theme) => {
		const answer = answerData(entry.data);
		return new Text(
			answer
				? theme.fg(
						answer.dismissed ? "warning" : "success",
						answer.dismissed ? "Question dismissed (not approval)" : `You answered: ${answer.answers.join(" · ")}`,
					)
				: "",
			0,
			0,
		);
	});
	const restore = (ctx: ExtensionContext) => {
		reset();
		// Session lifecycle boundaries are idle. Unlike request-local context edits,
		// this persists the recovered answer and survives compaction without replay.
		for (const { group, answer } of undeliveredRecords(ctx.sessionManager.getBranch()))
			pi.sendMessage(
				{ customType: RESPONSE_MESSAGE, content: answerMessage(group, answer), details: answer, display: false },
				{ triggerTurn: false },
			);
		refresh(ctx);
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => reset());
}
