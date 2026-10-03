import { expect, test } from "bun:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ANSWER_ENTRY,
	QUESTION_ENTRY,
	RESPONSE_MESSAGE,
	pendingQuestions,
	undeliveredAnswers,
	type QuestionGroup,
} from "./core/state.ts";
import { Conversation, type CoordinatorLookup } from "./runtime/conversation.ts";
import { answerRpcQuestions } from "./ui/rpc-questions.ts";
import extension from "./index.ts";

const group: QuestionGroup = {
	version: 1,
	id: "question",
	questions: [{ title: "Region?", options: ["Local", "Remote"] }],
};
function fixture(coordinator?: CoordinatorLookup) {
	const session = SessionManager.inMemory();
	const sent: any[] = [];
	const hooks = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const tools: any[] = [];
	const widgets: any[] = [];
	const ctx = {
		mode: "rpc",
		hasUI: false,
		sessionManager: session,
		ui: {
			notify() {},
			setWidget: (...args: any[]) => widgets.push(args),
			input: async () => "Local",
			select: async () => "1. Local",
		},
	} as unknown as ExtensionContext;
	const pi = {
		appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			if (options.triggerTurn === false)
				session.appendCustomMessageEntry(message.customType, message.content, false, message.details);
		},
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
			hooks.set(name, handler);
		},
		registerTool: (tool: any) => tools.push(tool),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI;
	return { session, sent, ctx, pi, hooks, tools, widgets, conversation: new Conversation(pi, coordinator) };
}

test("headless root persists questions immediately and resumes their branch", () => {
	const f = fixture();
	const base = f.session.appendCustomEntry("test/base", {});
	f.conversation.question(f.ctx, group.id, group.questions);
	expect(new Conversation(f.pi).pending(f.ctx)).toEqual([group]);
	const leaf = f.session.getLeafId()!;
	f.session.branch(base);
	expect(f.conversation.pending(f.ctx)).toEqual([]);
	f.session.branch(leaf);
	expect(f.conversation.pending(f.ctx)).toEqual([group]);
});
test("answers steer once, persist before delivery, reject duplicate/stale answers", () => {
	const f = fixture();
	f.conversation.question(f.ctx, group.id, group.questions);
	expect(() => f.conversation.answer(f.ctx, group, [])).toThrow("Answer every");
	f.conversation.answer(f.ctx, group, ["Local"]);
	expect(f.sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	expect(undeliveredAnswers(f.session.getBranch())[0]).toContain("Region?\nLocal");
	expect(() => f.conversation.answer(f.ctx, group, ["Remote"])).toThrow("no longer pending");
	expect(f.sent).toHaveLength(1);
});
test("dismissal never carries approval or partial answers", () => {
	const f = fixture();
	f.conversation.question(f.ctx, group.id, group.questions);
	f.conversation.answer(f.ctx, group, ["yes"], true);
	expect(f.sent[0].message.content).toContain("not approval");
	expect(f.sent[0].message.details.answers).toEqual([]);
});
test("child agents reject questions through pinned coordinator and upstream identity", () => {
	const child = fixture(() => ({ rootSessionId: "another-session" }));
	expect(() => child.conversation.question(child.ctx, group.id, group.questions)).toThrow("parent agent");
	const identity = fixture();
	identity.session.appendCustomEntry("session.identity/v1", { agentName: "/root/child" });
	expect(() => identity.conversation.question(identity.ctx, group.id, group.questions)).toThrow("parent agent");
});
test("pinned real coordinator binding rejects children without identity records", async () => {
	const module = await import(new URL("./runtime/coordinator.ts", import.meta.resolve("@luan.sh/pi-subagents")).href);
	const f = fixture(module.getCoordinatorForSession);
	const root = `test-${f.session.getSessionId()}`;
	module.createRootCoordinator(root);
	try {
		module.bindSessionToRoot(root, f.session.getSessionId());
		expect(() => f.conversation.question(f.ctx, group.id, group.questions)).toThrow("parent agent");
	} finally {
		module.removeRootCoordinator(root);
	}
});
test("RPC cancellation leaves question pending; a stale callback cannot answer", async () => {
	const f = fixture();
	f.ctx.hasUI = true;
	f.conversation.question(f.ctx, group.id, group.questions);
	f.ctx.ui.select = async () => undefined;
	await answerRpcQuestions(f.ctx, f.conversation);
	expect(f.conversation.pending(f.ctx)).toHaveLength(1);
	let resolve!: (answer: string) => void;
	f.ctx.ui.select = () =>
		new Promise((done) => {
			resolve = done;
		});
	const abort = new AbortController();
	const pending = answerRpcQuestions(f.ctx, f.conversation, abort.signal);
	abort.abort();
	resolve("1. Local");
	await pending;
	expect(f.sent).toHaveLength(0);
});
test("RPC free text handles duplicate suggested labels unambiguously", async () => {
	const f = fixture();
	f.ctx.hasUI = true;
	f.conversation.question(f.ctx, group.id, [{ title: "Answer?", options: ["Write an answer…"] }]);
	f.ctx.ui.select = async () => "Write an answer…";
	f.ctx.ui.input = async () => "custom";
	await answerRpcQuestions(f.ctx, f.conversation);
	expect(f.sent[0].message.details.answers).toEqual(["custom"]);
});
test("lifecycle restores lost steering durably once across resume/tree and compaction", async () => {
	const f = fixture();
	f.conversation.question(f.ctx, group.id, group.questions);
	f.conversation.answer(f.ctx, group, ["Local"]);
	await extension(f.pi);
	f.hooks.get("session_start")!({}, f.ctx);
	expect(f.sent).toHaveLength(2);
	expect(f.sent[1].options).toEqual({ triggerTurn: false });
	expect(undeliveredAnswers(f.session.getBranch())).toEqual([]);
	f.hooks.get("session_start")!({}, f.ctx);
	f.hooks.get("session_tree")!({}, f.ctx);
	f.session.appendCompaction("Summary", f.session.getLeafId()!, 100);
	f.hooks.get("session_start")!({}, f.ctx);
	expect(f.sent).toHaveLength(2);
	expect(
		f.session.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === RESPONSE_MESSAGE),
	).toHaveLength(1);
});
test("tool is model-only and runtime returns without waiting for UI", async () => {
	const f = fixture();
	await extension(f.pi);
	expect(f.tools).toHaveLength(1);
	expect(f.tools[0].exposure).toBe("model-only");
	const result = await f.tools[0].execute(group.id, { questions: group.questions }, undefined, undefined, f.ctx);
	expect(result.details.accepted).toBe(true);
	expect(pendingQuestions(f.session.getBranch())).toEqual([group]);
});
test("malformed records are ignored", () => {
	const f = fixture();
	f.session.appendCustomEntry(QUESTION_ENTRY, { version: 1, id: "bad", questions: [{ title: " " }] });
	f.session.appendCustomEntry(ANSWER_ENTRY, { version: 1, id: "bad", answers: false });
	expect(pendingQuestions(f.session.getBranch())).toEqual([]);
	expect(undeliveredAnswers(f.session.getBranch())).toEqual([]);
});

test("session shutdown cancels RPC dialogs and ignores delayed answers", async () => {
	const f = fixture();
	f.ctx.hasUI = true;
	let resolve!: (answer: string) => void;
	let signal: AbortSignal | undefined;
	f.ctx.ui.select = (_title, _options, config) => {
		signal = config?.signal;
		return new Promise((done) => {
			resolve = done;
		});
	};
	f.conversation.question(f.ctx, group.id, group.questions);
	await extension(f.pi);
	f.hooks.get("session_start")!({}, f.ctx);
	f.hooks.get("session_shutdown")!({}, f.ctx);
	expect(signal?.aborted).toBe(true);
	resolve("1. Local");
	await new Promise((done) => setTimeout(done, 0));
	expect(f.sent).toHaveLength(0);
	expect(f.conversation.pending(f.ctx)).toHaveLength(1);
});
