import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	ComponentStack,
	DialogButtonBar,
	DialogOverlay,
	icon,
	SelectableList,
	SemanticInput,
	type PointerEvent,
	tuiTheme,
} from "./libtui.ts";
import type { QuestionGroup } from "../core/state.ts";
import type { Conversation } from "../runtime/conversation.ts";

// libtui 0.3.9 predates the input hint/focus API used by upstream questions.
class QuestionInput extends SemanticInput {
	emptyHint = "";
	onFocus?: () => void;
	onMouse(event: PointerEvent): boolean {
		if (event.type !== "press" && event.type !== "release") return false;
		this.onFocus?.();
		return true;
	}
	override render(width: number): string[] {
		return !this.focused && !this.getValue() ? [truncateToWidth(this.emptyHint, width)] : super.render(width);
	}
}

interface InlineQuestionsOptions {
	// Pi renderers expose this public method, but the shared TUI interface omits it.
	tui: Pick<TUI, "requestRender" | "setFocus"> & { getFocusedComponent?(): Component | null };
	theme: Theme;
	onAnswer(group: QuestionGroup, answers: string[], dismissed: boolean): void;
}

/** A live question card above the editor; answering never opens an overlay. */
export class InlineQuestions extends DialogOverlay {
	private readonly content: InstanceType<typeof ComponentStack>;
	private group: QuestionGroup | undefined;
	private index = 0;
	private answers: string[] = [];
	private input: InstanceType<typeof SemanticInput> | undefined;
	private choices: Component | undefined;
	private previousFocus: Component | null = null;
	private pendingCount = 0;

	constructor(private readonly config: InlineQuestionsOptions) {
		const content = new ComponentStack();
		super(
			config.theme,
			content,
			() =>
				`${icon("comment")} Question ${this.index + 1}/${this.group?.questions.length ?? 0}${this.pendingCount > 1 ? ` · ${this.pendingCount} pending` : ""}`,
		);
		this.content = content;
	}

	update(groups: QuestionGroup[]): void {
		this.pendingCount = groups.length;
		if (this.group?.id !== groups[0]?.id || this.content.getChildren().length === 0) {
			this.blur();
			this.group = groups[0];
			this.index = 0;
			this.answers = [];
			this.rebuild();
		}
		this.config.tui.requestRender();
	}

	focus(): void {
		if (!this.group) return;
		const current = this.config.tui.getFocusedComponent?.();
		if (current === undefined) return;
		if (current !== this) this.previousFocus = current;
		this.config.tui.setFocus(this);
		this.config.tui.requestRender();
	}

	blur(): void {
		if (this.config.tui.getFocusedComponent?.() === this) this.config.tui.setFocus(this.previousFocus);
		this.previousFocus = null;
	}

	// Pi 1.0 dispatches native mouse events; libtui's host still dispatches onMouse.
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click") return { handled: true }; // press/release already activated it
		const handled = this.onMouse({
			type: event.type,
			row: event.y,
			col: event.x,
			screenRow: event.screenY,
			screenCol: event.screenX,
			button: event.button === "left" ? 0 : event.button === "middle" ? 1 : event.button === "right" ? 2 : undefined,
			wheel: event.wheelDelta ? (event.wheelDelta < 0 ? "up" : "down") : undefined,
			shift: event.shift,
			alt: event.alt,
			ctrl: event.ctrl,
		});
		return handled ? { handled: true, render: true } : undefined;
	}

	override handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.blur();
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.content.setActiveChild(
				this.content.getActiveChild() === this.input && this.choices ? this.choices : this.input,
			);
		} else super.handleInput(data);
		this.config.tui.requestRender();
	}

	override render(width: number): string[] {
		return this.group ? super.render(Math.min(width, 96)) : [];
	}

	private submit(answer: string): void {
		if (!this.group || !answer.trim()) return;
		this.answers[this.index] = answer.trim();
		if (this.index + 1 === this.group.questions.length) {
			this.blur();
			this.config.onAnswer(this.group, [...this.answers], false);
		} else {
			this.index++;
			this.rebuild();
		}
	}

	private rebuild(): void {
		const { tui, theme } = this.config;
		const colors = tuiTheme(theme);
		const children: Component[] = [];
		this.input = undefined;
		this.choices = undefined;
		const group = this.group;
		if (group) {
			const question = group.questions[this.index]!;
			children.push(new Text(theme.bold(colors.fg("text.primary", question.title)), 1, 0));
			children.push(
				new Text(
					colors.fg(
						"text.secondary",
						question.options?.length ? "Choose an option or write a reply." : "Write a reply below.",
					),
					1,
					0,
				),
			);
			children.push(new Spacer(1));
			if (question.options?.length) {
				this.choices = new SelectableList({
					items: question.options,
					maxVisible: 5,
					renderItem: (option, context) => {
						const active =
							(this.focused && this.content.getActiveChild() === this.choices && context.selected) || context.hovered;
						const lines = new Text(
							`${colors.fg("accent", icon("selection"))} ${colors.fg("text.primary", active ? theme.bold(option) : option)}`,
							1,
							0,
						).render(context.width);
						return active
							? lines.map((line) =>
									colors.bg("surface.selected", line + " ".repeat(Math.max(0, context.width - visibleWidth(line)))),
								)
							: lines;
					},
					requestRender: () => tui.requestRender(),
					onActivate: (option) => this.submit(option),
				});
				children.push(this.choices);
			}
			const input = new QuestionInput(theme);
			input.emptyHint = question.options?.length ? "Or type your own answer…" : "Type your answer…";
			input.onFocus = () => {
				this.content.setActiveChild(input);
				this.focus();
			};
			input.setValue(this.answers[this.index] ?? "");
			input.onSubmit = (value) => this.submit(value);
			input.onEscape = () => this.blur();
			this.input = input;
			children.push(new Text(colors.fg("text.secondary", `${icon("edit")} Your answer`), 1, 0));
			children.push(input);
			children.push(new Spacer(1));
			children.push(
				new DialogButtonBar({
					theme,
					buttons: [
						...(this.index > 0
							? [
									{
										value: "back",
										label: "Back",
										icon: "reset" as const,
										foreground: "text.primary" as const,
										background: "action.neutral" as const,
										align: "start" as const,
									},
								]
							: []),
						{
							value: "dismiss",
							label: "Dismiss",
							icon: "cancel",
							foreground: "text.primary",
							background: "action.neutral",
							align: "start",
						},
						{
							value: "submit",
							label: this.index + 1 === group.questions.length ? "Send" : "Next",
							icon: "submit",
							foreground: "text.primary",
							background: "action.positive",
						},
					],
					requestRender: () => tui.requestRender(),
					onActivate: (value) => {
						if (value === "dismiss") {
							this.blur();
							this.config.onAnswer(group, [], true);
						} else if (value === "back") {
							this.answers[this.index] = input.getValue();
							this.index--;
							this.rebuild();
						} else this.submit(input.getValue());
					},
				}),
			);
		}
		if (group)
			children.push({
				render: (width) =>
					this.focused
						? new Text(
								colors.fg("text.secondary", `${icon("interaction")} Tab choices/text · Enter answer · Esc chat`),
								1,
								0,
							).render(width)
						: [],
				invalidate() {},
			});
		this.content.setChildren(children);
		this.content.setActiveChild(this.choices ?? this.input);
		tui.requestRender();
	}
}

export class ConversationUI {
	private widget: InlineQuestions | undefined;
	private sessionId: string | undefined;
	private context: ExtensionContext | undefined;
	private generation = 0;
	constructor(private readonly conversation: Conversation) {}

	update(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const id = ctx.sessionManager.getSessionId();
		if (!this.widget || this.sessionId !== id) {
			this.dispose();
			this.sessionId = id;
			this.context = ctx;
			const generation = this.generation;
			ctx.ui.setWidget("pi-conversation/questions", (tui, theme) => {
				this.widget = new InlineQuestions({
					tui,
					theme,
					onAnswer: (group, answers, dismissed) => {
						if (generation !== this.generation) return;
						try {
							this.conversation.answer(ctx, group, answers, dismissed);
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						}
					},
				});
				this.widget.update(this.conversation.pending(ctx));
				return this.widget;
			});
		} else this.widget.update(this.conversation.pending(ctx));
	}

	focus(ctx: ExtensionContext): void {
		this.update(ctx);
		this.widget?.focus();
	}

	dispose(): void {
		this.generation++;
		this.widget?.update([]);
		this.context?.ui.setWidget("pi-conversation/questions", undefined);
		this.context = undefined;
		this.widget = undefined;
		this.sessionId = undefined;
	}
}
