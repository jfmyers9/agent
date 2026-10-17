import { relative } from "node:path";
import { createTwoFilesPatch } from "diff";
import { type FileMutation, MAX_MUTATION_TEXT } from "../shared/file-mutations.js";

const MAX_TURN_TEXT = 8_000_000;
const MAX_PREVIEW_LINES = 2000;
const MAX_PREVIEW_CHARS = 200_000;

/** Contiguous tool writes merge; an intervening writer starts a separate segment. */
export class TurnDiff {
	private readonly segments: FileMutation[] = [];
	private readonly latest = new Map<string, FileMutation>();
	private readonly notes = new Set<string>();
	private size = 0;
	private cached: string | undefined;
	private cachedCwd = "";

	reset(): void {
		this.segments.length = 0;
		this.latest.clear();
		this.notes.clear();
		this.size = 0;
		this.cached = undefined;
	}

	record(mutation: FileMutation): void {
		const { path, before, after } = mutation;
		if (before === after && before !== undefined) return;
		this.cached = undefined;
		const previous = this.latest.get(path);
		if (previous && previous.after !== before) {
			this.notes.add("Interleaved changes detected: separate edit segments are shown, not a combined net diff.");
		}
		const beforeSize = Buffer.byteLength(before ?? "", "utf8");
		const afterSize = Buffer.byteLength(after ?? "", "utf8");
		const merges = previous && previous.after === before;
		const nextSize = this.size + beforeSize + afterSize - (merges ? beforeSize * 2 : 0);
		if (
			before === undefined ||
			after === undefined ||
			beforeSize > MAX_MUTATION_TEXT ||
			afterSize > MAX_MUTATION_TEXT ||
			nextSize > MAX_TURN_TEXT
		) {
			this.notes.add(
				`Snapshot unavailable or size limit reached: ${path}. Changes may be omitted; inspect Repository.`,
			);
			this.latest.delete(path);
			return;
		}
		this.size = nextSize;
		if (merges) {
			// Retain only the first before and latest after; reverted edits disappear.
			previous.after = after;
		} else {
			const segment = { ...mutation };
			this.segments.push(segment);
			this.latest.set(path, segment);
		}
	}

	read(cwd: string): string {
		if (this.cached !== undefined && this.cachedCwd === cwd) return this.cached;
		this.cachedCwd = cwd;
		const parts = [...this.notes];
		let chars = parts.join("\n").length;
		let lines = parts.length;
		for (const { path, before, after } of this.segments) {
			if (before === after) continue;
			const name = relative(cwd, path) || path;
			let patch: string;
			if (before?.includes("\0") || after?.includes("\0")) {
				patch = `Binary file changed: ${name}\n`;
			} else {
				const kind = before === null ? "Added" : after === null ? "Deleted" : "Edited";
				patch = `${kind}: ${name}\n${
					createTwoFilesPatch(
						before === null ? "/dev/null" : `a/${name}`,
						after === null ? "/dev/null" : `b/${name}`,
						before ?? "",
						after ?? "",
						"",
						"",
						{ context: 3, timeout: 100 },
					) ?? "Diff computation limit reached; inspect Repository.\n"
				}`;
			}
			const remaining = Math.max(0, MAX_PREVIEW_LINES - lines);
			const preview = patch
				.split("\n")
				.slice(0, remaining)
				.join("\n")
				.slice(0, Math.max(0, MAX_PREVIEW_CHARS - chars));
			parts.push(preview);
			chars += preview.length;
			lines += preview.split("\n").length;
			if (preview.length < patch.length) {
				parts.push(
					"Preview truncated (2000 lines / 200,000 characters); inspect Repository for the working-tree diff.",
				);
				break;
			}
		}
		this.cached = parts.filter(Boolean).join("\n");
		return this.cached;
	}
}
