import type { Component, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type RenderTheme = {
	fg(role: string, text: string): string;
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

export function textComponent(text: string): Text {
	return new Text(text, 0, 0);
}

export function padToVisibleWidth(text: string, width: number): string {
	const rendered = truncateToWidth(text, width, "…", true);
	return `${rendered}${" ".repeat(Math.max(0, width - visibleWidth(rendered)))}`;
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
