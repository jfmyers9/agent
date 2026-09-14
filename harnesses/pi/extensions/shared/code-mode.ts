import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { codeModeFunctionToolAdapter, registerCodeModeToolAdapter } from "@luan.sh/pi-code-mode/sdk";
import type { TSchema } from "typebox";
import { bindAdapterOwner } from "./code-mode-ownership.ts";

type Owner = Pick<ExtensionAPI, "registerTool"> & Partial<Pick<ExtensionAPI, "on">>;
type State = {
	lifted: Set<string>;
	unregister: Map<string, () => void>;
	identities: Map<string, object>;
	session?: object;
};
type BridgeState = {
	protocol: "agent/code-mode-bridge/v1";
	owners: WeakMap<object, State>;
	sessions: WeakMap<object, Set<State>>;
	policies: WeakMap<object, (name: string) => boolean>;
};

// Pi reloads each extension through Jiti without a module cache. Share the
// capability across those module instances, retaining session-local decisions.
function bridgeState(): BridgeState {
	const key = Symbol.for("agent/code-mode-bridge/v1");
	const root = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = root[key] as Partial<BridgeState> | undefined;
	if (
		existing?.protocol === "agent/code-mode-bridge/v1" &&
		existing.owners instanceof WeakMap &&
		existing.sessions instanceof WeakMap &&
		existing.policies instanceof WeakMap
	)
		return existing as BridgeState;
	const created: BridgeState = {
		protocol: "agent/code-mode-bridge/v1",
		owners: new WeakMap(),
		sessions: new WeakMap(),
		policies: new WeakMap(),
	};
	root[key] = created;
	return created;
}
const { owners, sessions, policies } = bridgeState();

function stateFor(pi: Owner): State {
	const existing = owners.get(pi);
	if (existing) return existing;
	const state: State = { lifted: new Set(), unregister: new Map(), identities: new Map() };
	owners.set(pi, state);
	pi.on?.("session_start", (_event, ctx) => {
		if (!ctx?.sessionManager) return;
		if (state.session) sessions.get(state.session)?.delete(state);
		state.session = ctx.sessionManager;
		for (const owner of state.identities.values()) bindAdapterOwner(owner, ctx.sessionManager);
		const group = sessions.get(ctx.sessionManager) ?? new Set<State>();
		group.add(state);
		sessions.set(ctx.sessionManager, group);
	});
	pi.on?.("session_shutdown", (event) => {
		state.lifted.clear();
		if (state.session) sessions.get(state.session)?.delete(state);
		if (event?.reason === "reload" || event?.reason === "quit") {
			for (const unregister of state.unregister.values()) unregister();
			state.unregister.clear();
		}
	});
	return state;
}

export function isToolLifted(pi: object, name: string): boolean {
	return owners.get(pi)?.lifted.has(name) ?? false;
}

export function listSessionLiftedTools(sessionManager: object): string[] {
	return [...new Set([...(sessions.get(sessionManager) ?? [])].flatMap((state) => [...state.lifted]))];
}

export function setCodeModeToolPolicy(sessionManager: object, isDisabled: (name: string) => boolean): void {
	policies.set(sessionManager, isDisabled);
}

/** Register one execution path and renderer for direct and composed calls. */
export function registerCodeModeTool<TParams extends TSchema, TDetails, TState = any>(
	pi: Owner,
	tool: ToolDefinition<TParams, TDetails, TState>,
	options: { mapResult?: (result: AgentToolResult<TDetails>) => AgentToolResult<TDetails> } = {},
): void {
	pi.registerTool(tool);
	const state = stateFor(pi);
	state.unregister.get(tool.name)?.();
	const adapter = codeModeFunctionToolAdapter(tool, {
		// Text is often the actual result while details only contains rendering metadata.
		resultValue: (result) => ({ content: result.content, details: result.details }),
	});
	adapter.owner = state.identities.get(tool.name) ?? tool;
	state.identities.set(tool.name, adapter.owner);
	bindAdapterOwner(adapter.owner, state.session);
	const invoke = adapter.invoke.bind(adapter);
	adapter.prepareInput = (input) => {
		const prepared = tool.prepareArguments ? tool.prepareArguments(input) : input;
		return validateToolArguments(tool, {
			type: "toolCall",
			id: "nested",
			name: tool.name,
			arguments: prepared as Record<string, unknown>,
		});
	};
	adapter.onScopeChange = (scope) => {
		if (scope) state.lifted.add(tool.name);
		else state.lifted.delete(tool.name);
	};
	adapter.invoke = async (input, context, signal) => {
		if (policies.get(context.extensionContext.sessionManager)?.(tool.name)) {
			throw new Error(
				`${tool.name} is disabled by the token-burden extension. Toggle it on from /token-burden if needed.`,
			);
		}
		signal.throwIfAborted();
		const raw = await invoke(input, context, signal);
		const result = options.mapResult ? options.mapResult(raw as AgentToolResult<TDetails>) : raw;
		const details = result.details as Record<string, unknown> | undefined;
		if (
			(result as { isError?: boolean }).isError ||
			details?.error === true ||
			(typeof details?.exit_code === "number" && details.exit_code !== 0) ||
			details?.timed_out === true ||
			details?.cancelled === true ||
			typeof details?.session_error === "string"
		) {
			context.onUpdate?.(result);
			throw new Error(
				result.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n") || `${tool.name} failed`,
			);
		}
		return result;
	};
	state.unregister.set(tool.name, registerCodeModeToolAdapter(adapter));
}
