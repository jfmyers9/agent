import { type ExtensionContext, keyText } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, getKeybindings, Input } from "@earendil-works/pi-tui";

export type NavResult<T> = { action: "value"; value: T } | { action: "back" } | { action: "cancel" };

class NavSelectComponent implements Component {
	private selected = 0;

	constructor(
		private title: string,
		private options: string[],
		private theme: ExtensionContext["ui"]["theme"],
		private done: (result: NavResult<string>) => void,
	) {}

	invalidate(): void {}

	render(): string[] {
		const lines = [this.theme.fg("accent", this.title), ""];
		for (const [index, option] of this.options.entries()) {
			const prefix = index === this.selected ? this.theme.fg("accent", "› ") : "  ";
			const text = index === this.selected ? this.theme.fg("accent", option) : option;
			lines.push(`${prefix}${text}`);
		}
		lines.push(
			"",
			this.theme.fg(
				"muted",
				`${keyText("tui.select.up")}/${keyText("tui.select.down")} navigate · ← back · ${keyText("tui.select.cancel")} cancel · ${keyText("tui.select.confirm")} select`,
			),
		);
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selected = this.selected === 0 ? this.options.length - 1 : this.selected - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selected = this.selected === this.options.length - 1 ? 0 : this.selected + 1;
			return;
		}
		if (data === "\u001b[D") {
			this.done({ action: "back" });
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done({ action: "cancel" });
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) this.done({ action: "value", value: this.options[this.selected] });
	}
}

class NavInputComponent implements Component, Focusable {
	private input = new Input();

	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}

	constructor(
		private title: string,
		private theme: ExtensionContext["ui"]["theme"],
		private done: (result: NavResult<string>) => void,
		private allowEmpty = false,
	) {
		this.input.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed || this.allowEmpty) this.done({ action: "value", value: trimmed });
		};
		this.input.onEscape = () => this.done({ action: "cancel" });
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		return [
			this.theme.fg("accent", this.title),
			"",
			...this.input.render(width),
			"",
			this.theme.fg(
				"muted",
				`← back when empty · ${keyText("tui.select.cancel")} cancel · ${keyText("tui.select.confirm")} submit`,
			),
		];
	}

	handleInput(data: string): void {
		if (data === "\u001b[D" && this.input.getValue().length === 0) {
			this.done({ action: "back" });
			return;
		}
		this.input.handleInput(data);
	}
}

export async function navSelect(ctx: ExtensionContext, title: string, options: string[]): Promise<NavResult<string>> {
	return ctx.ui.custom<NavResult<string>>(
		(_tui, theme, _kb, done) => new NavSelectComponent(title, options, theme, done),
	);
}

export async function navInput(ctx: ExtensionContext, title: string): Promise<NavResult<string>> {
	return ctx.ui.custom<NavResult<string>>((_tui, theme, _kb, done) => new NavInputComponent(title, theme, done));
}

export async function navOptionalInput(ctx: ExtensionContext, title: string): Promise<NavResult<string>> {
	return ctx.ui.custom<NavResult<string>>((_tui, theme, _kb, done) => new NavInputComponent(title, theme, done, true));
}
