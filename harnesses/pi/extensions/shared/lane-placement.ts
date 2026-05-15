export type LanePlacement = "new-window" | "split-pane" | "hidden";
export type LaneSplitDirection = "horizontal" | "vertical";
export type LaneMux = "auto" | "tmux" | "zellij" | "pty" | "none";
export type ResolvedLaneBackend = "tmux" | "zellij" | "none";

export interface ResolveLaneBackendOptions {
	requested: LaneMux;
	currentBackend?: "tmux" | "zellij";
	tmuxAvailable: () => Promise<boolean>;
	zellijAvailable: () => Promise<boolean>;
}

export async function resolveLaneBackend(options: ResolveLaneBackendOptions): Promise<ResolvedLaneBackend> {
	if (options.requested === "none") return "none";
	if (options.requested === "pty") {
		if (!(await options.zellijAvailable())) throw new Error("zellij backend is unavailable");
		return "zellij";
	}
	if (options.requested === "tmux") {
		if (!(await options.tmuxAvailable())) throw new Error("tmux backend is unavailable");
		return "tmux";
	}
	if (options.requested === "zellij") {
		if (!(await options.zellijAvailable())) throw new Error("zellij backend is unavailable");
		return "zellij";
	}
	if (options.currentBackend === "tmux" && (await options.tmuxAvailable())) return "tmux";
	if (options.currentBackend === "zellij" && (await options.zellijAvailable())) return "zellij";
	if (await options.tmuxAvailable()) return "tmux";
	if (await options.zellijAvailable()) return "zellij";
	throw new Error("tmux or zellij backend is unavailable");
}

export interface LanePlacementRequest {
	placement: LanePlacement;
	cwd: string;
	name: string;
	command: string;
	env?: Record<string, string>;
	detached?: boolean;
	captureWindowId?: boolean;
	targetWorkspace?: string;
	targetPane?: string;
	splitDirection?: LaneSplitDirection;
	splitSizePercent?: number;
}

export interface TmuxLanePlacementRef {
	backend: "tmux";
	tmux: {
		session: string;
		windowId?: string;
		windowName?: string;
		paneId?: string;
		placement: LanePlacement;
		splitDirection?: LaneSplitDirection;
		splitSizePercent?: number;
	};
}

export interface ZellijLanePlacementRef {
	backend: "zellij";
	zellij: {
		session?: string;
		tabId?: string;
		tabName?: string;
		paneId?: string;
		placement: LanePlacement;
		sessionOwned?: boolean;
	};
}

export interface TmuxLanePlacementOptions {
	exec: (args: string[]) => Promise<string>;
}

export class TmuxLanePlacement {
	constructor(private readonly options: TmuxLanePlacementOptions) {}

	async place(request: LanePlacementRequest): Promise<TmuxLanePlacementRef> {
		if (request.placement === "hidden") {
			const raw = await this.options.exec([
				"new-session",
				"-d",
				"-P",
				"-F",
				"#{session_id} #{window_id} #{pane_id}",
				"-s",
				request.name,
				"-c",
				request.cwd,
				...tmuxEnvArgs(request.env),
				request.command,
			]);
			const [hiddenSession, windowId, paneId] = raw.trim().split(/\s+/, 3);
			return {
				backend: "tmux",
				tmux: {
					session: hiddenSession || request.name,
					windowId,
					windowName: request.name,
					paneId,
					placement: "hidden",
				},
			};
		}
		const targetWorkspace = request.targetWorkspace?.trim() || undefined;
		const session = targetWorkspace ?? (await this.options.exec(["display-message", "-p", "#S"]));
		if (request.placement === "new-window") {
			const target = await this.nextWindowTarget(session);
			const outputFormat = request.captureWindowId ? "#{window_id} #{pane_id}" : "#{pane_id}";
			const raw = await this.options.exec([
				"new-window",
				...(request.detached ? ["-d"] : []),
				"-P",
				"-F",
				outputFormat,
				"-t",
				target,
				"-n",
				request.name,
				"-c",
				request.cwd,
				...tmuxEnvArgs(request.env),
				request.command,
			]);
			const [windowId, paneId] = request.captureWindowId ? raw.trim().split(/\s+/, 2) : [target, raw];
			return {
				backend: "tmux",
				tmux: { session, windowId, windowName: request.name, paneId, placement: "new-window" },
			};
		}
		if (request.placement === "split-pane") {
			const currentWindow = request.targetPane
				? await this.options
						.exec(["display-message", "-p", "-t", request.targetPane, "#S:#I"])
						.catch(() => request.targetPane)
				: targetWorkspace
					? `${session}:`
					: await this.options.exec(["display-message", "-p", "#S:#I"]).catch(() => session);
			const targetArgs: string[] = request.targetPane
				? ["-t", String(request.targetPane)]
				: targetWorkspace
					? ["-t", String(currentWindow)]
					: [];
			const paneId = await this.options.exec([
				"split-window",
				...splitDirectionArgs(request),
				...splitSizeArgs(request),
				"-P",
				"-F",
				"#{pane_id}",
				...targetArgs,
				"-c",
				request.cwd,
				...tmuxEnvArgs(request.env),
				request.command,
			]);
			return {
				backend: "tmux",
				tmux: {
					session,
					windowId: currentWindow,
					windowName: request.name,
					paneId,
					placement: "split-pane",
					splitDirection: request.splitDirection,
					splitSizePercent: request.splitSizePercent,
				},
			};
		}
		throw new Error(`Unsupported tmux lane placement: ${request.placement}`);
	}

	private async nextWindowTarget(session: string): Promise<string> {
		const [baseIndexOutput, windowsOutput] = await Promise.all([
			this.options.exec(["show-options", "-gv", "-t", session, "base-index"]).catch(() => "0"),
			this.options.exec(["list-windows", "-t", session, "-F", "#{window_index}"]),
		]);
		const baseIndex = Number.parseInt(baseIndexOutput.trim(), 10);
		const used = new Set(
			windowsOutput
				.split("\n")
				.map((line) => Number.parseInt(line.trim(), 10))
				.filter((index) => Number.isFinite(index)),
		);
		let index = Number.isFinite(baseIndex) ? baseIndex : 0;
		while (used.has(index)) index += 1;
		return `${session}:${index}`;
	}
}

function splitDirectionArgs(request: LanePlacementRequest): string[] {
	if (request.splitDirection === "horizontal") return ["-h"];
	if (request.splitDirection === "vertical") return ["-v"];
	return [];
}

function splitSizeArgs(request: LanePlacementRequest): string[] {
	return request.splitSizePercent === undefined ? [] : ["-p", String(request.splitSizePercent)];
}

function tmuxEnvArgs(env: Record<string, string> | undefined): string[] {
	if (!env) return [];
	return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

export interface ZellijLanePlacementOptions {
	exec: (args: string[]) => Promise<string>;
}

export class ZellijLanePlacement {
	constructor(private readonly options: ZellijLanePlacementOptions) {}

	async place(request: LanePlacementRequest): Promise<ZellijLanePlacementRef> {
		const targetWorkspace = request.targetWorkspace?.trim() || undefined;
		if (request.placement === "split-pane") {
			if (request.targetPane) {
				await this.options.exec([...zellijSessionArgs(targetWorkspace), "action", "focus-pane-id", request.targetPane]);
			}
			const paneId = await this.options.exec([
				...zellijSessionArgs(targetWorkspace),
				"action",
				"new-pane",
				"--direction",
				zellijDirection(request.splitDirection),
				"--name",
				request.name,
				"--cwd",
				request.cwd,
				"--",
				"sh",
				"-lc",
				commandWithEnv(request.command, request.env),
			]);
			return {
				backend: "zellij",
				zellij: { session: targetWorkspace, paneId, placement: "split-pane" },
			};
		}

		const hiddenSession =
			request.placement === "hidden" ? (targetWorkspace ?? compactZellijSessionName(request.name)) : targetWorkspace;
		if (request.placement === "hidden") {
			await this.options.exec([
				"attach",
				"--create-background",
				hiddenSession ?? compactZellijSessionName(request.name),
			]);
		}
		const tabId = await this.options.exec([
			...zellijSessionArgs(hiddenSession),
			"action",
			"new-tab",
			"--name",
			request.name,
			"--cwd",
			request.cwd,
			"--",
			"sh",
			"-lc",
			commandWithEnv(request.command, request.env),
		]);
		return {
			backend: "zellij",
			zellij: {
				session: hiddenSession,
				tabId,
				tabName: request.name,
				placement: request.placement,
				sessionOwned: request.placement === "hidden" ? true : undefined,
			},
		};
	}
}

function zellijSessionArgs(session: string | undefined): string[] {
	return session ? ["--session", session] : [];
}

function zellijDirection(direction: LaneSplitDirection | undefined): string {
	return direction === "vertical" ? "down" : "right";
}

function compactZellijSessionName(name: string): string {
	const normalized = (name || "lane").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
	if (normalized.length <= 16) return normalized;
	const hash = stableHash(normalized).toString(36).slice(0, 6);
	return `${normalized.slice(0, 9)}-${hash}`;
}

function stableHash(value: string): number {
	let hash = 5381;
	for (const char of value) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
	return hash;
}

function commandWithEnv(command: string, env: Record<string, string> | undefined): string {
	if (!env || Object.keys(env).length === 0) return command;
	return `${formatEnv(env)} exec ${command}`;
}

function formatEnv(env: Record<string, string>): string {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
