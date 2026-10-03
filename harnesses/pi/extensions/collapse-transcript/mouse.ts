import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { PointerEvent } from "./libtui.ts";

const NATIVE = Symbol("collapse-transcript/native-mouse");
interface Pointer extends PointerEvent {
	[NATIVE]?: { event: TuiMouseEvent; result?: TuiMouseEventResult };
}

/** Translate at the projection boundary; legacy nested stacks retain local coordinates. */
export function handleNativeMouse(
	target: { onMouse(event: Pointer): boolean },
	event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
	const exchange: NonNullable<Pointer[typeof NATIVE]> = { event };
	const handled = target.onMouse({
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
		[NATIVE]: exchange,
	});
	return exchange.result ?? (handled ? { handled: true, render: true, capture: event.type === "press" } : undefined);
}

/** Display-only wrapper: never takes ownership of the native component or its history. */
export class NativeMouseAdapter implements Component {
	private width = 0;
	private height = 0;
	constructor(private readonly component: Component) {}
	render(width: number): string[] {
		this.width = width;
		const rows = this.component.render(width);
		this.height = rows.length;
		return rows;
	}
	invalidate(): void {
		this.component.invalidate();
	}
	handleInput(data: string): void {
		this.component.handleInput?.(data);
	}
	onMouse(event: Pointer): boolean {
		const exchange = event[NATIVE];
		if (exchange && this.component.handleMouse && event.type !== "enter" && event.type !== "leave") {
			const result = this.component.handleMouse({
				...exchange.event,
				x: event.col,
				y: event.row,
				width: this.width,
				height: this.height,
			});
			if (result) exchange.result = result;
			return Boolean(result?.handled || result?.capture || result?.focus);
		}
		const legacy = this.component as Component & { onMouse?(event: PointerEvent): boolean };
		return legacy.onMouse?.(event) ?? false;
	}
}
