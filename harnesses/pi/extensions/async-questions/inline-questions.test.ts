import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getFgAnsi: () => "\x1b[37m",
	getBgAnsi: () => "\x1b[40m",
} as unknown as Theme;
import {
	type Component,
	isFocusable,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { QuestionGroup } from "./core/state.ts";
import { InlineQuestions } from "./ui/questions.ts";

function fixture() {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	const editor = { focused: true, render: () => ["existing chat draft"], invalidate() {} };
	let focused: Component | null = editor;
	const delivered: { answers: string[]; dismissed: boolean }[] = [];
	const group: QuestionGroup = {
		version: 1,
		id: "one",
		questions: [{ title: "Which color?", options: ["Green", "Blue"] }, { title: "What label?" }],
	};
	const card = new InlineQuestions({
		theme,
		tui: {
			requestRender() {},
			getFocusedComponent: () => focused,
			setFocus(component) {
				if (isFocusable(focused)) focused.focused = false;
				focused = component;
				if (isFocusable(component)) component.focused = true;
			},
		},
		onAnswer: (_group, answers, dismissed) => {
			delivered.push({ answers, dismissed });
			card.update([]);
		},
	});
	card.update([group]);
	const lines = (width = 80) => card.render(width).map(stripTerminalSequences);
	function click(text: string, width = 80) {
		const rendered = lines(width);
		const row = rendered.findIndex((line) => line.includes(text));
		expect(row).toBeGreaterThanOrEqual(0);
		const col = rendered[row]!.indexOf(text);
		for (const type of ["press", "release"] as const) {
			card.onMouse({
				type,
				row,
				col,
				screenRow: row,
				screenCol: col,
				button: 0,
				wheel: undefined,
				shift: false,
				alt: false,
				ctrl: false,
			});
		}
	}
	return { card, group, editor, delivered, lines, click, focused: () => focused };
}

test("inline choice and free text submit one group and restore the existing editor", () => {
	const f = fixture();
	expect(f.lines().join("\n")).toContain("Or type your own answer");
	expect(f.focused()).toBe(f.editor);
	expect(f.delivered).toEqual([]);
	f.click("Green");
	expect(f.delivered).toEqual([]);
	expect(f.lines().join("\n")).toContain("What label?");
	f.click("Type your answer");
	expect(f.focused()).toBe(f.card);
	f.card.handleInput("Ready");
	f.card.update([f.group]);
	expect(f.lines().join("\n")).toContain("Ready");
	f.card.handleInput("\r");
	expect(f.delivered).toEqual([{ answers: ["Green", "Ready"], dismissed: false }]);
	expect(f.focused()).toBe(f.editor);
	expect(f.lines().join("\n")).not.toContain("What label?");
});

test("Escape keeps the inline draft, Back permits revision, and dismissal never sends partial answers", () => {
	const f = fixture();
	f.click("Or type");
	f.card.handleInput("Purple");
	f.card.handleInput("\x1b");
	expect(f.focused()).toBe(f.editor);
	expect(f.lines().join("\n")).toContain("Purple");
	f.click("Next");
	f.click("Back");
	expect(f.lines().join("\n")).toContain("Purple");
	f.click("Blue");
	f.click("Dismiss");
	expect(f.delivered).toEqual([{ answers: [], dismissed: true }]);
});

test("keyboard selection is explicit and replacing the pending group releases focus", () => {
	const f = fixture();
	f.card.focus();
	f.card.handleInput("\x1b[B");
	expect(f.delivered).toEqual([]);
	f.card.handleInput("\r");
	f.card.handleInput("\r");
	expect(f.delivered).toEqual([]);
	f.card.update([{ ...f.group, id: "another" }]);
	expect(f.focused()).toBe(f.editor);
	expect(f.lines().join("\n")).toContain("Question 1/2");
});

test("narrow cards keep actions visible and wrapped choices clickable", () => {
	const f = fixture();
	const option = "This answer wraps onto multiple lines inside the card";
	f.card.update([
		{
			...f.group,
			id: "wrapped",
			questions: [
				{ title: "Which presentation should the question card use for a narrow terminal?", options: [option] },
			],
		},
	]);
	const lines = f.lines(40);
	expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	expect(lines.join("\n")).toContain("Dismiss");
	expect(lines.join("\n")).toContain("Send");
	f.click("inside the card", 40);
	expect(f.delivered).toEqual([{ answers: [option], dismissed: false }]);
	expect(f.focused()).toBe(f.editor);
});

test("native Pi mouse protocol routes choices and input without double-submitting clicks", () => {
	const f = fixture();
	const click = (text: string) => {
		const lines = f.lines();
		const y = lines.findIndex((line) => line.includes(text));
		const x = lines[y]!.indexOf(text);
		for (const type of ["press", "release", "click"] as const)
			f.card.handleMouse({
				type,
				x,
				y,
				screenX: x,
				screenY: y,
				width: 80,
				height: lines.length,
				button: "left",
				shift: false,
				alt: false,
				ctrl: false,
			});
	};
	click("Green");
	click("Type your answer");
	expect(f.focused()).toBe(f.card);
	f.card.handleInput("Label");
	f.card.handleInput("\r");
	expect(f.delivered).toEqual([{ answers: ["Green", "Label"], dismissed: false }]);
	expect(f.focused()).toBe(f.editor);
});

test("widget disposal clears mounted UI, restores focus, and invalidates stale callbacks", async () => {
	const { ConversationUI } = await import("./ui/questions.ts");
	const { Conversation } = await import("./runtime/conversation.ts");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { QUESTION_ENTRY } = await import("./core/state.ts");
	const f = fixture();
	const session = SessionManager.inMemory();
	session.appendCustomEntry(QUESTION_ENTRY, f.group);
	let card: InlineQuestions | undefined;
	let focused: Component | null = f.editor;
	const cleared: string[] = [];
	let delivered = 0;
	const conversation = new Conversation({
		appendEntry: () => {
			delivered++;
		},
		sendMessage() {},
	} as any);
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: session,
		ui: {
			notify() {},
			setWidget: (name: string, factory: any) => {
				if (!factory) {
					cleared.push(name);
					return;
				}
				card = factory(
					{
						requestRender() {},
						getFocusedComponent: () => focused,
						setFocus: (component: Component | null) => {
							focused = component;
						},
					},
					theme,
				);
			},
		},
	} as any;
	const ui = new ConversationUI(conversation);
	ui.update(ctx);
	ui.focus(ctx);
	expect(focused).toBe(card);
	const old = card!;
	ui.dispose();
	expect(cleared).toEqual(["pi-conversation/questions"]);
	expect(focused).toBe(f.editor);
	expect(old.render(80)).toEqual([]);
	old.handleInput("\r");
	expect(delivered).toBe(0);
	ui.update(ctx);
	expect(card).not.toBe(old);
	expect(card!.render(80).join("\n")).toContain("Which color?");
	ui.dispose();
});
