import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Input } from "@earendil-works/pi-tui";

// Pinned libtui ships TS against the older Pi mouse contract. Keep its legacy
// pointer protocol behind this narrow boundary, rather than importing its entire
// incompatible source type graph. UI tests exercise these runtime contracts.
export interface PointerEvent {
	type: string;
	row: number;
	col: number;
	screenRow: number;
	screenCol: number;
	button?: number;
	wheel?: string;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}
export interface Stack extends Component {
	setChildren(children: Component[]): void;
	getChildren(): Component[];
	setActiveChild(child: Component | undefined): void;
	getActiveChild(): Component | undefined;
}
interface Dialog extends Component {
	focused: boolean;
	handleInput(data: string): void;
	onMouse(event: PointerEvent): boolean;
}
interface Library {
	ComponentStack: new () => Stack;
	DialogOverlay: new (theme: Theme, child: Component, title: () => string) => Dialog;
	SemanticInput: new (theme: Theme) => Input;
	SelectableList: new <T>(options: {
		items: T[];
		maxVisible: number;
		renderItem(item: T, context: { selected: boolean; hovered: boolean; width: number }): string[];
		requestRender(): void;
		onActivate(item: T): void;
	}) => Component;
	DialogButtonBar: new (options: {
		theme: Theme;
		buttons: { value: string; label: string; icon: string; foreground: string; background: string; align?: string }[];
		requestRender(): void;
		onActivate(value: string): void;
	}) => Component;
	icon(name: string): string;
	tuiTheme(theme: Theme): { fg(token: string, text: string): string; bg(token: string, text: string): string };
}
const libraryPath = import.meta.resolve("@luan.sh/pi-libtui");
export const { ComponentStack, DialogOverlay, SemanticInput, SelectableList, DialogButtonBar, icon, tuiTheme } =
	(await import(libraryPath)) as Library;
