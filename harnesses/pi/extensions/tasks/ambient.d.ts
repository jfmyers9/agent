declare const process: {
	cwd(): string;
	pid: number;
	env: Record<string, string | undefined>;
	stdout: { rows?: number; columns?: number };
};

declare module "node:crypto" {
	export function randomBytes(size: number): Uint8Array;
	export function createHash(algorithm: string): {
		update(data: string): { digest(encoding: string): string };
	};
}

declare module "node:child_process" {
	export function execFileSync(command: string, args?: readonly string[], options?: Record<string, unknown>): string;
}

declare module "node:fs" {
	export const constants: { X_OK: number };
	export function accessSync(path: string, mode?: number): void;
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string, encoding: string): string;
	export function readdirSync(
		path: string,
		options: { withFileTypes: true },
	): { name: string; isDirectory(): boolean }[];
	export const realpathSync: {
		(path: string): string;
		native(path: string): string;
	};
}

declare module "node:fs/promises" {
	export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	export function readFile(path: string, encoding: string): Promise<string>;
	export function rename(oldPath: string, newPath: string): Promise<void>;
	export function writeFile(path: string, data: string, encoding: string): Promise<void>;
}

declare module "node:path" {
	export const delimiter: string;
	export function basename(path: string): string;
	export function dirname(path: string): string;
	export function join(...parts: string[]): string;
	export function resolve(...parts: string[]): string;
}

declare module "node:url" {
	export function fileURLToPath(url: string): string;
}

declare module "@earendil-works/pi-ai" {
	export function StringEnum<T extends readonly string[]>(values: T): unknown;
}

declare module "@earendil-works/pi-coding-agent" {
	export interface Theme {
		fg(role: string, text: string): string;
		bg(role: string, text: string): string;
		bold(text: string): string;
		strikethrough?(text: string): string;
	}
	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		signal?: AbortSignal;
		ui: {
			theme: Theme;
			notify?(message: string, level?: string): void;
			setWidget?(id: string, value: unknown, options?: Record<string, unknown>): void;
			custom<T>(
				factory: (
					tui: import("@earendil-works/pi-tui").TUI,
					theme: Theme,
					keybindings: unknown,
					done: (value: T) => void,
				) => import("@earendil-works/pi-tui").Component,
				options?: Record<string, unknown>,
			): Promise<T>;
		};
		sessionManager?: { getSessionFile?(): string | undefined };
	}
	export interface ExtensionAPI {
		events: {
			emit(channel: string, data: unknown): void;
			on?(channel: string, handler: (data: unknown) => void): () => void;
		};
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
		registerTool(definition: Record<string, unknown>): void;
		registerCommand(name: string, definition: Record<string, unknown>): void;
		registerShortcut?(key: string, definition: Record<string, unknown>): void;
		sendMessage?(message: Record<string, unknown>, options?: Record<string, unknown>): void;
		getSessionName?(): string | undefined;
	}
}

declare module "@earendil-works/pi-tui" {
	export interface Component {
		render(width: number): string[];
		handleInput?(data: string): void;
		invalidate(): void;
	}
	export interface TUI {
		requestRender(): void;
	}
	export interface EditorTheme {
		borderColor: (text: string) => string;
		selectList: {
			description: (text: string) => string;
			noMatch: (text: string) => string;
			scrollInfo: (text: string) => string;
			selectedPrefix: (text: string) => string;
			selectedText: (text: string) => string;
		};
	}
	export class Editor implements Component {
		onSubmit?: (text: string) => void;
		constructor(tui: TUI, theme: EditorTheme, options?: Record<string, unknown>);
		getText(): string;
		handleInput(data: string): void;
		invalidate(): void;
		render(width: number): string[];
		setAutocompleteProvider(provider: unknown): void;
		setText(text: string): void;
	}
	export class Text implements Component {
		constructor(text: string, paddingX?: number, paddingY?: number);
		invalidate(): void;
		render(width: number): string[];
		setText(text: string): void;
	}
	export class CombinedAutocompleteProvider {
		constructor(providers: unknown[], cwd?: string, fdPath?: string | null);
	}
	export const Key: {
		readonly escape: string;
		readonly enter: string;
		readonly tab: string;
		readonly space: string;
		readonly up: string;
		readonly down: string;
		readonly left: string;
		readonly right: string;
		readonly ctrl: (key: string) => string;
		readonly shift: (key: string) => string;
	};
	export function matchesKey(data: string, key: string): boolean;
	export function truncateToWidth(text: string, width: number, ...options: unknown[]): string;
	export function visibleWidth(text: string): number;
}

declare module "typebox" {
	export const Type: {
		Object(schema: Record<string, unknown>, options?: Record<string, unknown>): unknown;
		String(options?: Record<string, unknown>): unknown;
		Number(options?: Record<string, unknown>): unknown;
		Boolean(options?: Record<string, unknown>): unknown;
		Array(item: unknown, options?: Record<string, unknown>): unknown;
		Optional(item: unknown): unknown;
	};
}
