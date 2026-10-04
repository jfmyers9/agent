import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { DiffView } from "./view.js";

// Keep the older library's Pi source types behind the same narrow runtime
// boundary as collapse-transcript; the host owns layout, focus, and disposal.
export interface PaneHost {
	tui: TUI;
	getTerminalSize(): { columns: number; rows: number };
	requestRender(): void;
	focus(): void;
	blur(): void;
	isFocused(): boolean;
}
export interface PaneDefinition {
	id: string;
	position: "right";
	size: number;
	minMainSize: number;
	priority: number;
	component(host: PaneHost, theme: Theme): Component & { dispose(): void };
}
export type MountPane = (definition: PaneDefinition, scope: typeof globalThis) => () => void;
const libraryPath = import.meta.resolve("@luan.sh/pi-libtui");
export const { mountSplitPane } = (await import(libraryPath)) as { mountSplitPane: MountPane };

export const MIN_PANE_COLUMNS = 120;

export class DiffPane {
	private enabled = true;
	private disposed = false;
	private diff = "";
	private unmount?: () => void;
	private pending?: Promise<void>;
	private dirty = false;
	private readonly views = new Map<PaneHost, DiffView>();

	constructor(
		private readonly read: () => Promise<string>,
		private readonly terminal: () => { columns: number; rows: number; fullscreen: boolean },
		private readonly mount: MountPane = mountSplitPane,
	) {}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.syncLayout();
		if (enabled) void this.refresh();
	}

	toggle(): boolean {
		this.setEnabled(!this.enabled);
		return this.enabled;
	}

	focus(): boolean {
		this.syncLayout();
		for (const host of this.views.keys()) {
			if (host.tui.hasOverlay()) return false;
			if (host.isFocused()) host.blur();
			else host.focus();
			host.requestRender();
			return true;
		}
		return false;
	}

	// Called outside rendering (including after terminal resize). A narrow or
	// regular-mode terminal gets its entire main layout back, not an overlay.
	syncLayout(): void {
		if (this.disposed) return;
		const { columns, rows, fullscreen } = this.terminal();
		const visible = this.enabled && !!this.diff && fullscreen && columns >= MIN_PANE_COLUMNS && rows >= 8;
		if (!visible) {
			this.unmount?.();
			this.unmount = undefined;
			return;
		}
		if (this.unmount) return;
		this.unmount = this.mount(
			{
				id: "pi.diff-prod",
				position: "right",
				size: Math.max(40, Math.floor(columns * 0.38)),
				minMainSize: 72,
				priority: -10,
				component: (host, theme) => {
					const view = new DiffView(
						this.diff,
						theme,
						() => host.getTerminalSize().rows,
						() => host.requestRender(),
						() => {
							host.blur();
							host.requestRender();
						},
						() => host.isFocused(),
					);
					this.views.set(host, view);
					return {
						render: (width) => view.render(width),
						handleInput: (data) => view.handleInput(data),
						invalidate: () => view.invalidate(),
						dispose: () => {
							this.views.delete(host);
						},
					};
				},
			},
			globalThis,
		);
	}

	refresh(): Promise<void> {
		if (this.disposed || !this.enabled) return Promise.resolve();
		this.dirty = true;
		if (this.pending) return this.pending;
		this.pending = this.drain().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	private async drain(): Promise<void> {
		while (this.dirty && !this.disposed && this.enabled) {
			this.dirty = false;
			let diff: string;
			try {
				diff = await this.read();
			} catch {
				// Never leave a stale diff visible. Explicit /diff-prod reports errors;
				// automatic refresh stays quiet outside repositories or with bad config.
				diff = "";
			}
			if (this.disposed) return;
			if (diff !== this.diff) {
				this.diff = diff;
				for (const [host, view] of this.views) {
					view.update(diff);
					host.requestRender();
				}
			}
			this.syncLayout();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.unmount?.();
		this.unmount = undefined;
		this.views.clear();
	}
}
