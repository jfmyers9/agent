// Shared across Pi's independently evaluated extension modules and child loaders.
const protocol = "pi-code-mode/adapter-owner-sessions/v1";
const key = Symbol.for(protocol);
type OwnerSessions = {
	protocol: typeof protocol;
	hasOwner(owner: object): boolean;
	sessionForOwner(owner: object): object | undefined;
	bind(owner: object, session: object | undefined): void;
};
const shared = globalThis as typeof globalThis & { [key]?: OwnerSessions };

function registry(): OwnerSessions {
	if (shared[key]) return shared[key];
	const sessions = new WeakMap<object, object | undefined>();
	const created: OwnerSessions = {
		protocol,
		hasOwner: (owner) => sessions.has(owner),
		sessionForOwner: (owner) => sessions.get(owner),
		bind: (owner, session) => {
			sessions.set(owner, session);
		},
	};
	shared[key] = created;
	return created;
}

/** Reserve before session_start so a different concurrently loaded child cannot claim this owner. */
export function bindAdapterOwner(owner: object, sessionManager?: object): void {
	registry().bind(owner, sessionManager);
}
