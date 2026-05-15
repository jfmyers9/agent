import { spawn } from "node:child_process";

export type CtResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type RunCommandOptions = {
	signal?: AbortSignal;
	input?: string;
	allowNonZero?: boolean;
};

export function formatCommand(command: string, args: string[]): string {
	return [command, ...args.map((arg) => (/[\s\t]/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

export function runCommand(
	command: string,
	args: string[],
	cwd: string,
	signalOrOptions?: AbortSignal | RunCommandOptions,
	input?: string,
): Promise<CtResult> {
	const options = isRunCommandOptions(signalOrOptions) ? signalOrOptions : { signal: signalOrOptions, input };
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdinError: NodeJS.ErrnoException | undefined;
		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const resolveOnce = (result: CtResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const child = spawn(command, args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				rejectOnce(new Error(`${command} not found on PATH`));
				return;
			}
			rejectOnce(error);
		});
		child.stdin.on("error", (error) => {
			stdinError = error as NodeJS.ErrnoException;
			if (stdinError.code === "EPIPE" || stdinError.code === "ERR_STREAM_DESTROYED") return;
			rejectOnce(stdinError);
		});

		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		if (options.input === undefined) {
			child.stdin.end();
		} else {
			child.stdin.end(options.input);
		}

		child.on("close", (exitCode) => {
			options.signal?.removeEventListener("abort", onAbort);
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (exitCode === 0 || options.allowNonZero) {
				resolveOnce({ stdout, stderr, exitCode: exitCode ?? 0 });
				return;
			}
			const stdinMessage = stdinError ? `: ${stdinError.message}` : "";
			rejectOnce(
				new Error(
					`${formatCommand(command, args)} failed with exit code ${exitCode ?? 1}${stderr.trim() ? `: ${stderr.trim()}` : stdinMessage}`,
				),
			);
		});
	});
}

function isRunCommandOptions(value: unknown): value is RunCommandOptions {
	return Boolean(value && typeof value === "object" && !("aborted" in (value as Record<string, unknown>)));
}
