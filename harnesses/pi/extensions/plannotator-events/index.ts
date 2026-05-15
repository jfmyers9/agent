import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const GUARD_SYMBOL = Symbol.for("agents.plannotatorEventGuard");

type EventHandler = (data: unknown) => void | Promise<void>;
type Unsubscribe = () => void;

type GuardedEventBus = {
	on?: (channel: string, handler: EventHandler) => Unsubscribe;
	clear?: () => void;
	[GUARD_SYMBOL]?: {
		originalOn: (channel: string, handler: EventHandler) => Unsubscribe;
		activePlannotatorUnsubscribe?: Unsubscribe;
	};
};

export function installPlannotatorEventGuard(pi: ExtensionAPI): void {
	const events = (pi as ExtensionAPI & { events?: GuardedEventBus }).events;
	if (typeof events?.on !== "function") return;

	const existingGuard = events[GUARD_SYMBOL];
	if (existingGuard) {
		existingGuard.activePlannotatorUnsubscribe?.();
		events.clear?.();
		existingGuard.activePlannotatorUnsubscribe = undefined;
		return;
	}

	events.clear?.();

	const originalOn = events.on.bind(events);
	const guard: NonNullable<GuardedEventBus[typeof GUARD_SYMBOL]> = { originalOn };
	events[GUARD_SYMBOL] = guard;

	events.on = (channel, handler) => {
		if (channel !== PLANNOTATOR_REQUEST_CHANNEL) {
			return originalOn(channel, handler);
		}

		guard.activePlannotatorUnsubscribe?.();
		const unsubscribe = originalOn(channel, handler);
		let active = true;
		const guardedUnsubscribe = () => {
			if (!active) return;
			active = false;
			if (guard.activePlannotatorUnsubscribe === guardedUnsubscribe) {
				guard.activePlannotatorUnsubscribe = undefined;
			}
			unsubscribe();
		};
		guard.activePlannotatorUnsubscribe = guardedUnsubscribe;
		return guardedUnsubscribe;
	};
}

export default function plannotatorEventsExtension(pi: ExtensionAPI) {
	installPlannotatorEventGuard(pi);
}
