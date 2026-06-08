import { existsSync } from "node:fs";

function firstExistingShell(candidates: string[]): string {
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1] ?? "/bin/sh";
}

export const DEFAULT_EXEC_SHELL =
	process.platform === "darwin"
		? firstExistingShell(["/bin/zsh", "/bin/bash", "/bin/sh"])
		: firstExistingShell(["/bin/bash", "/bin/zsh", "/bin/sh"]);

export function isFishShell(shell: string | undefined): boolean {
	const name = shell?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return name === "fish";
}

export function resolveRuntimeShell(shell: string | undefined): string {
	if (!shell) {
		return DEFAULT_EXEC_SHELL;
	}
	return isFishShell(shell) ? DEFAULT_EXEC_SHELL : shell;
}
