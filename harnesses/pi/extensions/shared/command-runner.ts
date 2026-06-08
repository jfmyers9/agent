import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type CommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type RunCommandOptions = {
	signal?: AbortSignal;
	input?: string;
	allowNonZero?: boolean;
	extraSearchPaths?: readonly string[];
};

type CommandBuffers = {
	stdout: Buffer[];
	stderr: Buffer[];
};

export function formatCommand(command: string, args: readonly string[]): string {
	return [command, ...args.map((arg) => (/[\s\t]/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

function isRunCommandOptions(value: unknown): value is RunCommandOptions {
	return Boolean(value && typeof value === "object" && !("aborted" in (value as Record<string, unknown>)));
}

function normalizeOptions(signalOrOptions?: AbortSignal | RunCommandOptions, input?: string): RunCommandOptions {
	return isRunCommandOptions(signalOrOptions) ? signalOrOptions : { signal: signalOrOptions, input };
}

function expandPathEntry(entry: string): string | undefined {
	if (entry === "~") return process.env.HOME;
	if (entry.startsWith("~/")) return process.env.HOME ? join(process.env.HOME, entry.slice(2)) : undefined;
	return entry;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveCommand(command: string, extraSearchPaths: readonly string[] = []): string | undefined {
	if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) return command;
	const paths = [...(process.env.PATH ?? "").split(delimiter), ...extraSearchPaths]
		.map(expandPathEntry)
		.filter((entry): entry is string => Boolean(entry));
	for (const searchPath of new Set(paths)) {
		const candidate = join(searchPath, command);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

function assertReadableCwd(cwd: string): void {
	try {
		accessSync(cwd, constants.R_OK);
	} catch {
		throw new Error(`Working directory not found: ${cwd}`);
	}
}

function collectOutput(child: ReturnType<typeof spawn>): CommandBuffers {
	const buffers: CommandBuffers = { stdout: [], stderr: [] };
	child.stdout?.on("data", (chunk) => buffers.stdout.push(Buffer.from(chunk)));
	child.stderr?.on("data", (chunk) => buffers.stderr.push(Buffer.from(chunk)));
	return buffers;
}

function decodeBuffers(buffers: CommandBuffers): Pick<CommandResult, "stdout" | "stderr"> {
	return {
		stdout: Buffer.concat(buffers.stdout).toString("utf8"),
		stderr: Buffer.concat(buffers.stderr).toString("utf8"),
	};
}

function commandFailure(
	command: string,
	args: string[],
	exitCode: number | null,
	stderr: string,
	stdinError?: Error,
): Error {
	const stdinMessage = stdinError ? `: ${stdinError.message}` : "";
	const stderrMessage = stderr.trim() ? `: ${stderr.trim()}` : stdinMessage;
	return new Error(`${formatCommand(command, args)} failed with exit code ${exitCode ?? 1}${stderrMessage}`);
}

export function runCommand(
	command: string,
	args: string[],
	cwd: string,
	signalOrOptions?: AbortSignal | RunCommandOptions,
	input?: string,
): Promise<CommandResult> {
	const options = normalizeOptions(signalOrOptions, input);
	const resolvedCommand = resolveCommand(command, options.extraSearchPaths) ?? command;
	assertReadableCwd(cwd);

	return new Promise((resolve, reject) => {
		let stdinError: NodeJS.ErrnoException | undefined;
		const child = spawn(resolvedCommand, args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const buffers = collectOutput(child);
		const onAbort = () => child.kill();

		child.on("error", (error) => {
			reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${command} not found on PATH`) : error);
		});
		child.stdin.on("error", (error) => {
			stdinError = error as NodeJS.ErrnoException;
			if (stdinError.code !== "EPIPE" && stdinError.code !== "ERR_STREAM_DESTROYED") reject(stdinError);
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.end(options.input);

		child.on("close", (exitCode) => {
			options.signal?.removeEventListener("abort", onAbort);
			const output = decodeBuffers(buffers);
			if (exitCode === 0 || options.allowNonZero) resolve({ ...output, exitCode: exitCode ?? 0 });
			else reject(commandFailure(command, args, exitCode, output.stderr, stdinError));
		});
	});
}
