import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRef, TaskEnvelope } from "./types.js";

type Selection = { model: ModelRef; reason: string };

export interface SubagentRoutingController {
	/** True only when the independent bounded-subagent routing preference is enabled. */
	isEnabled(ctx: ExtensionContext): boolean;
	route(task: TaskEnvelope, ctx: ExtensionContext, signal?: AbortSignal): Promise<Selection>;
	onDecision?(
		ctx: ExtensionContext,
		decision: { kind: "subagent"; task: string; model: ModelRef; reason: string },
	): void;
}

interface Assignment {
	controller: AbortController;
	promise: Promise<Selection>;
	waiters: number;
	settled: boolean;
	notified: boolean;
}

interface Scope {
	closed: boolean;
	assignments: Map<string, Assignment>;
}

function cancelled(): Error {
	const error = new Error("Subagent routing cancelled");
	error.name = "AbortError";
	return error;
}

/** Race even controllers that ignore cancellation, removing listeners on either outcome. */
async function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw cancelled();
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(cancelled());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Match the installed spawn_agent's string-only fork parser, without changing its arguments. */
function forkKind(value: unknown): "inherit" | "bounded" | "invalid" {
	if (value === undefined) return "inherit";
	if (typeof value !== "string") return "invalid";
	const fork = value.trim();
	if (!fork || fork === "all") return "inherit";
	if (fork === "none") return "bounded";
	return /^[1-9]\d*$/.test(fork) && Number.isSafeInteger(Number(fork)) ? "bounded" : "invalid";
}

function modelSelector(selection: Selection): string {
	const { provider, id } = selection.model ?? {};
	if (
		typeof provider !== "string" ||
		!provider ||
		provider.includes("/") ||
		provider.trim() !== provider ||
		typeof id !== "string" ||
		!id ||
		id.trim() !== id ||
		typeof selection.reason !== "string" ||
		`${provider}/${id}`.length > 512
	) {
		throw new Error("Subagent routing returned an invalid model selection");
	}
	return `${provider}/${id}`;
}

/** Patch only new, bounded-context spawn calls; the installed tool still owns execution and permissions. */
export function registerSubagentRouting(pi: Pick<ExtensionAPI, "on">, controller: SubagentRoutingController): void {
	// The context object is fresh for each hook; the session manager is the stable runtime identity.
	const scopes = new WeakMap<ExtensionContext["sessionManager"], Map<string, Scope>>();
	const stopped = new WeakSet<ExtensionContext["sessionManager"]>();
	function reset(ctx: ExtensionContext): void {
		const sessions = scopes.get(ctx.sessionManager);
		if (!sessions) return;
		for (const scope of sessions.values()) {
			scope.closed = true;
			for (const entry of scope.assignments.values()) entry.controller.abort();
			scope.assignments.clear();
		}
		scopes.delete(ctx.sessionManager);
	}
	pi.on("session_start", (_event, ctx) => {
		reset(ctx);
		stopped.delete(ctx.sessionManager);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		reset(ctx);
		stopped.add(ctx.sessionManager);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "spawn_agent") return;
		const input = event.input as Record<string, unknown>;
		// Preserve explicit choices, including malformed ones: native validation owns those errors.
		if (input.model !== undefined) return;
		try {
			if (!controller.isEnabled(ctx)) return;
			const fork = forkKind(input.fork_turns);
			if (fork === "inherit") return; // Never throw away history just to permit a model override.
			if (fork === "invalid") throw new Error("fork_turns must be none, all, or a positive integer string");
			if (stopped.has(ctx.sessionManager)) throw cancelled();
			if (typeof input.message !== "string" || !input.message.trim()) {
				throw new Error("spawn_agent requires message for routing");
			}
			const descriptor = Object.getOwnPropertyDescriptor(input, "model");
			if (descriptor ? !descriptor.writable : !Object.isExtensible(input)) {
				throw new Error("Cannot apply subagent routing to immutable arguments");
			}
			const signal = ctx.signal;
			if (signal?.aborted) throw cancelled();
			const manager = ctx.sessionManager;
			let sessions = scopes.get(manager);
			if (!sessions) {
				sessions = new Map();
				scopes.set(manager, sessions);
			}
			const sessionId = manager.getSessionId();
			let scope = sessions.get(sessionId);
			if (!scope) {
				scope = { closed: false, assignments: new Map() };
				sessions.set(sessionId, scope);
			}
			const task = input.message;
			const key = JSON.stringify([event.toolCallId, input.task_name, task, input.fork_turns]);
			let entry = scope.assignments.get(key);
			if (!entry) {
				const abort = new AbortController();
				const pending = Promise.resolve().then(() => {
					if (abort.signal.aborted) throw cancelled();
					return controller.route({ task }, ctx, abort.signal);
				});
				entry = {
					controller: abort,
					promise: withSignal(pending, abort.signal),
					waiters: 0,
					settled: false,
					notified: false,
				};
				scope.assignments.set(key, entry);
				const assignment = entry;
				void entry.promise.then(
					() => {
						assignment.settled = true;
					},
					() => {
						assignment.settled = true;
						if (scope.assignments.get(key) === assignment) scope.assignments.delete(key);
					},
				);
			}
			entry.waiters++;
			try {
				const selection = await withSignal(entry.promise, signal);
				if (scope.closed || signal?.aborted) throw cancelled();
				// A manual choice or profile change while classification was pending always wins.
				if (input.model !== undefined || !controller.isEnabled(ctx)) return;
				if (JSON.stringify([event.toolCallId, input.task_name, input.message, input.fork_turns]) !== key) {
					throw new Error("spawn_agent arguments changed during routing");
				}
				const selector = modelSelector(selection);
				if (!Reflect.set(input, "model", selector) || input.model !== selector) {
					throw new Error("Cannot apply subagent routing to arguments");
				}
				if (!entry.notified) {
					try {
						controller.onDecision?.(ctx, { kind: "subagent", task, ...selection });
						entry.notified = true;
					} catch (error) {
						if (descriptor) Reflect.defineProperty(input, "model", descriptor);
						else Reflect.deleteProperty(input, "model");
						throw error;
					}
				}
			} finally {
				entry.waiters--;
				// One cancelled preflight must not poison another waiter for the same assignment.
				if (!entry.settled && entry.waiters === 0) {
					if (scope.assignments.get(key) === entry) scope.assignments.delete(key);
					entry.controller.abort();
				}
			}
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : "Subagent routing failed" };
		}
	});
}
