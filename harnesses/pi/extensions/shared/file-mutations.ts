import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FILE_MUTATION_EVENT = "agent:file-mutation";
export const MAX_MUTATION_TEXT = 1_000_000;

/** null means absent; undefined means the snapshot could not safely be captured. */
export interface FileMutation {
	path: string;
	before: string | null | undefined;
	after: string | null | undefined;
}
export type MutationReporter = (mutation: FileMutation) => void;
export interface ToolFileMutation extends FileMutation {
	toolCallId: string;
}

export function mutationReporter(pi: Pick<ExtensionAPI, "events">, toolCallId: string): MutationReporter {
	return (mutation) => pi.events?.emit(FILE_MUTATION_EVENT, { ...mutation, toolCallId } satisfies ToolFileMutation);
}

async function snapshot(path: string): Promise<string | null | undefined> {
	try {
		const info = await stat(path);
		// Never try to snapshot devices, pipes, or directories before a write.
		if (!info.isFile() || info.size > MAX_MUTATION_TEXT) return undefined;
		const text = await readFile(path, "utf8");
		return Buffer.byteLength(text, "utf8") > MAX_MUTATION_TEXT ? undefined : text;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
	}
}

/** Call inside the mutator's file queue, not from tool-start/end observers.
 * These snapshots are UI-only: never put them in tool results or session entries.
 */
export async function observeFileMutation(
	path: string,
	after: string | null,
	write: () => Promise<unknown>,
	report?: MutationReporter,
): Promise<void> {
	const before = report ? await snapshot(path) : undefined;
	try {
		await write();
	} catch (error) {
		// A failed write may have partially changed the file. Do not invent its result.
		report?.({ path, before, after: undefined });
		throw error;
	}
	report?.({
		path,
		before,
		after: after !== null && Buffer.byteLength(after, "utf8") > MAX_MUTATION_TEXT ? undefined : after,
	});
}
