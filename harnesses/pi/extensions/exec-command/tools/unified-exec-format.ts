import type { UnifiedExecResult } from "./exec-session-manager.ts";

function isProcessStillRunning(result: UnifiedExecResult): boolean {
	return (
		result.process_id !== undefined &&
		result.exit_code === undefined &&
		result.terminal_state === undefined &&
		result.timed_out !== true &&
		result.cancelled !== true &&
		result.session_error === undefined
	);
}

export function formatUnifiedExecResult(result: UnifiedExecResult, command?: string): string {
	const sections: string[] = [];

	if (command) {
		sections.push(`Command: ${command}`);
	}
	if (result.chunk_id) {
		sections.push(`Chunk ID: ${result.chunk_id}`);
	}
	sections.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`);

	if (result.exit_code !== undefined) {
		sections.push(`Process exited with code ${result.exit_code}`);
	}
	if (result.timed_out) {
		sections.push("Process timed out");
	}
	if (result.cancelled) {
		sections.push("Process cancelled");
	}
	if (result.session_error) {
		sections.push(`Session error: ${result.session_error}`);
	}
	if (isProcessStillRunning(result)) {
		sections.push(`Process running with process ID ${result.process_id}`);
		if (result.stdin_open) {
			sections.push("TTY: yes");
		}
	}
	if (result.original_token_count !== undefined) {
		sections.push(`Original token count: ${result.original_token_count}`);
	}

	sections.push("Output:");
	sections.push(result.output);

	return sections.join("\n");
}
