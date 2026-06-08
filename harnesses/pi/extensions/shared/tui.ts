import type { Component, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type RenderTheme = {
	fg(role: string, text: string): string;
	bg?(role: string, text: string): string;
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
	};
};

const ANSI_RESET = "\x1b[0m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

export function textComponent(text: string): Text {
	return new Text(text, 0, 0);
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

export function runningFrame(startedAtMs: number, nowMs = Date.now()): string {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const index = Math.floor((nowMs - startedAtMs) / 120) % frames.length;
	return frames[index] ?? frames[0];
}

export function shineText(text: string): string {
	return text;
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
