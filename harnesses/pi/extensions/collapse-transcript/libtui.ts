import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
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

// Pinned LibTUI exposes older Pi source types. Limit that compatibility boundary
// to the runtime contracts exercised by transcript.test.ts, not its full graph.
export type TranscriptEntry =
	| { kind: "content"; key: object; component: Component }
	| {
			kind: "thinking";
			key: object;
			component: Component;
			summary: string;
			running: boolean;
			failed: boolean;
			timestamp?: number;
	  }
	| {
			kind: "tool";
			key: object;
			component: Component;
			summary: string;
			running: boolean;
			failed: boolean;
			toolCallId?: string;
	  };
export interface MotionMount {
	dispose(): void;
}
interface Stack extends Component {
	setChildren(children: Component[]): void;
	onMouse(event: PointerEvent): boolean;
}
interface ActivityView {
	action: { verb: string; status: "running" | "succeeded" | "failed"; marker?: false };
	running?: boolean;
	payload?: { kind: "component"; preview: Component; full: Component };
}
export interface ToolActivity extends Component {
	update(view: ActivityView): void;
	dispose(): void;
}
interface Library {
	ComponentStack: new () => Stack;
	sanitizeTuiFieldPreview(text: string, limit: number): string;
	sharedMotionScheduler: { mount(target: { requestRender(): void }, options: { cadenceMs: number }): MotionMount };
	tuiTheme(theme: Theme): { fg(token: string, text: string): string };
}
interface ToolLibrary {
	ToolActivity: new (options: {
		theme: Theme;
		requestRender(): void;
		action: Component;
		view: ActivityView;
	}) => ToolActivity;
	mountTranscriptProjection(
		tui: TUI,
		create: (entries: () => readonly TranscriptEntry[]) => Component & { dispose(): void },
	): (() => void) | undefined;
}
const libraryPath = import.meta.resolve("@luan.sh/pi-libtui");
const toolPath = import.meta.resolve("@luan.sh/pi-libtui/tool");
export const { ComponentStack, sanitizeTuiFieldPreview, sharedMotionScheduler, tuiTheme } = (await import(
	libraryPath
)) as Library;
export const { ToolActivity, mountTranscriptProjection } = (await import(toolPath)) as ToolLibrary;
