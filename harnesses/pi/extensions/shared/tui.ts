import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type RenderTheme = {
	fg(role: string, text: string): string;
	bg?(role: string, text: string): string;
	getFgAnsi?(role: string): string | undefined;
	bold(text: string): string;
};

type OverlayHostOptions = {
	overlay?: boolean;
	overlayOptions?: unknown;
};

type TuiSessionContext = {
	ui: {
		custom?<T>(
			factory: (tui: TUI, theme: RenderTheme, keybindings: unknown, done: (value: T) => void) => Component,
			options?: OverlayHostOptions,
		): Promise<T>;
		setWidget?(key: string, content: WidgetContent, options?: WidgetOptions): void;
	};
};

type MessageRenderer = (...args: any[]) => unknown;
type EntryRenderer = (...args: any[]) => unknown;
type WidgetContent = undefined | string[] | ((tui: TUI, theme: RenderTheme) => Component & { dispose?: () => void });
type WidgetOptions = { placement?: "aboveEditor" | "belowEditor" };
type OrderedWidgetTarget =
	| ExtensionContext
	| { setWidget(key: string, content: WidgetContent, options?: WidgetOptions): void };

type Rgb = [number, number, number];
type ShineTextOptions = {
	role?: string;
	baseScale?: number;
	shineScale?: number;
	shineWidth?: number;
	percolationMs?: number;
	fallback?: (text: string) => string;
};
type PulseGlyphOptions = {
	role?: string;
	periodMs?: number;
	lowScale?: number;
	highScale?: number;
};

const ANSI_RESET = "\x1b[0m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RGB_FALLBACK: Rgb = [0xff, 0xff, 0xff];
const orderedAboveEditorKeys = ["background-terminals", "prompt-storage-stash"];
const orderedWidgetStates = new WeakMap<
	object,
	{ entries: Map<string, { content: Exclude<WidgetContent, undefined>; options: WidgetOptions }>; applying: boolean }
>();

export class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

export function textComponent(text: string): Text {
	return new Text(text, 0, 0);
}

export function registerExtensionMessageRenderer(
	pi: { registerMessageRenderer?: (customType: string, renderer: MessageRenderer) => void },
	customType: string,
	renderer: MessageRenderer,
): void {
	pi.registerMessageRenderer?.(customType, renderer);
}

export function registerExtensionEntryRenderer(pi: object, customType: string, renderer: EntryRenderer): void {
	const api = pi as { registerEntryRenderer?: (customType: string, renderer: EntryRenderer) => void };
	api.registerEntryRenderer?.(customType, renderer);
}

export function padToVisibleWidth(text: string, width: number): string {
	const rendered = truncateToWidth(text, width, "…", true);
	return `${rendered}${" ".repeat(Math.max(0, width - visibleWidth(rendered)))}`;
}

export function sgrResetsBackground(rawParams: string): boolean {
	if (rawParams.trim() === "") return true;
	return rawParams
		.split(";")
		.map((param) => Number.parseInt(param, 10))
		.some((param) => param === 0 || param === 49);
}

export function keepBackgroundAcrossResets(text: string, backgroundAnsi: string): string {
	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		if (!sgrResetsBackground(rawParams)) return sequence;
		return `${sequence}${backgroundAnsi}`;
	});
}

export function paintAnsiBackgroundRow(line: string, width: number, backgroundAnsi: string | undefined): string {
	const padded = truncateToWidth(line, width, "", true);
	if (!backgroundAnsi) return padded;
	return `${backgroundAnsi}${keepBackgroundAcrossResets(padded, backgroundAnsi)}${ANSI_RESET}`;
}

export function clampAnsiLine(line: string, width: number): string {
	return truncateToWidth(line.replace(OSC_SEQUENCE_PATTERN, ""), width, "", true);
}

export function runningFrame(elapsedMs: number | undefined, frameMs = 120): string {
	if (elapsedMs === undefined) return RUNNING_FRAMES[0] ?? "";
	return RUNNING_FRAMES[Math.floor(elapsedMs / frameMs) % RUNNING_FRAMES.length] ?? RUNNING_FRAMES[0] ?? "";
}

export function shineText(
	theme: RenderTheme,
	text: string,
	elapsedMs: number | undefined,
	options: ShineTextOptions = {},
): string {
	const role = options.role ?? "accent";
	if (!themeRoleAnsi(theme, role)) return options.fallback?.(text) ?? text;
	const base = scaleRgb(themeRoleToRgb(theme, role), options.baseScale ?? 0.55);
	const shine = scaleRgb(themeRoleToRgb(theme, role), options.shineScale ?? 1.55);
	const chars = [...text];
	const shineWidth = options.shineWidth ?? 3;
	const step = Math.floor((elapsedMs ?? 0) / (options.percolationMs ?? 80));
	const cycle = chars.length + shineWidth;
	const pos = step % cycle;
	return `${chars
		.map((char, index) => `${rgbFg(index >= pos - shineWidth && index < pos ? shine : base)}${char}`)
		.join("")}\x1b[39m`;
}

export function pulseGlyph(
	theme: RenderTheme,
	glyph: string,
	elapsedMs: number | undefined,
	options: PulseGlyphOptions = {},
): string {
	const role = options.role ?? "accent";
	if (!themeRoleAnsi(theme, role)) return theme.fg(role, glyph);
	const color = scaleRgb(
		themeRoleToRgb(theme, role),
		triangleWave(elapsedMs ?? 0, options.periodMs ?? 1_200, options.lowScale ?? 0.45, options.highScale ?? 1.45),
	);
	return `${rgbFg(color)}${glyph}\x1b[39m`;
}

function triangleWave(elapsedMs: number, periodMs: number, lo: number, hi: number): number {
	const t = (elapsedMs % periodMs) / periodMs;
	return lo + (1 - Math.abs(2 * t - 1)) * (hi - lo);
}

function themeRoleAnsi(theme: RenderTheme, role: string): string | undefined {
	const hex = parseHexRgb(role);
	if (hex) return rgbFg(hex);
	if (theme.getFgAnsi) return theme.getFgAnsi(role);
	const sample = theme.fg(role, "x");
	const marker = sample.indexOf("x");
	const ansi = marker >= 0 ? sample.slice(0, marker) : undefined;
	return ansi?.includes("\x1b[38;") ? ansi : undefined;
}

function themeRoleToRgb(theme: RenderTheme, role: string): Rgb {
	const hex = parseHexRgb(role);
	if (hex) return hex;
	const ansi = themeRoleAnsi(theme, role);
	const truecolor = ansi?.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const color256 = ansi?.match(/\x1b\[38;5;(\d+)m/);
	if (color256) return ansi256ToRgb(Number(color256[1]));
	return RGB_FALLBACK;
}

function scaleRgb([r, g, b]: Rgb, factor: number): Rgb {
	const scale = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
	return [scale(r), scale(g), scale(b)];
}

function rgbFg([r, g, b]: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

function parseHexRgb(color: string): Rgb | undefined {
	const match = color.match(/^#?([0-9a-fA-F]{6})$/);
	if (!match) return undefined;
	const hex = match[1] ?? "";
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
	];
}

function ansi256ToRgb(code: number): Rgb {
	if (code < 16) {
		const base: Rgb[] = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		];
		return base[code] ?? RGB_FALLBACK;
	}
	if (code <= 231) {
		const n = code - 16;
		const component = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		return [component(Math.floor(n / 36)), component(Math.floor((n % 36) / 6)), component(n % 6)];
	}
	const gray = 8 + (code - 232) * 10;
	return [gray, gray, gray];
}

export function setOrderedAboveEditorWidget(target: OrderedWidgetTarget, key: string, content: WidgetContent): void {
	const ui =
		"ui" in target
			? (target.ui as { setWidget?: (key: string, content: WidgetContent, options?: WidgetOptions) => void })
			: target;
	if (!ui.setWidget) return;
	const orderedUi = ui as { setWidget(key: string, content: WidgetContent, options?: WidgetOptions): void };
	const state = orderedWidgetStateFor(orderedUi);
	const hadEntry = state.entries.has(key);
	if (content === undefined) {
		state.entries.delete(key);
		orderedUi.setWidget(key, undefined);
		return;
	}
	state.entries.set(key, { content, options: { placement: "aboveEditor" } });
	if (!hadEntry && state.entries.size === 1) orderedUi.setWidget(key, content, { placement: "aboveEditor" });
	else applyOrderedWidgets(orderedUi, state);
}

function orderedWidgetStateFor(ui: object) {
	const existing = orderedWidgetStates.get(ui);
	if (existing) return existing;
	const state = {
		entries: new Map<string, { content: Exclude<WidgetContent, undefined>; options: WidgetOptions }>(),
		applying: false,
	};
	orderedWidgetStates.set(ui, state);
	return state;
}

function applyOrderedWidgets(
	ui: { setWidget(key: string, content: WidgetContent, options?: WidgetOptions): void },
	state: ReturnType<typeof orderedWidgetStateFor>,
): void {
	if (state.applying) return;
	state.applying = true;
	try {
		for (const key of orderedAboveEditorKeys.filter((candidate) => state.entries.has(candidate)))
			ui.setWidget(key, undefined);
		for (const key of orderedAboveEditorKeys.filter((candidate) => state.entries.has(candidate))) {
			const entry = state.entries.get(key)!;
			ui.setWidget(key, entry.content, entry.options);
		}
	} finally {
		state.applying = false;
	}
}

export function defineExtensionTui(_options: { id: string }) {
	return {
		bind(ctx: TuiSessionContext) {
			return {
				overlays: {
					openComponent<T>(
						factory: (tui: TUI, theme: RenderTheme, keybindings: unknown, done: (value: T) => void) => Component,
						options: OverlayHostOptions = { overlay: true },
					): Promise<T> {
						if (!ctx.ui.custom) {
							throw new Error("ctx.ui.custom is unavailable for overlay Host Surface");
						}
						return ctx.ui.custom(factory, {
							overlay: options.overlay ?? true,
							overlayOptions: options.overlayOptions,
						});
					},
				},
			};
		},
	};
}
