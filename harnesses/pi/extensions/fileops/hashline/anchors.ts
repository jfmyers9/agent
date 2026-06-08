import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { formatHashlineHeader } from "./format.js";
import { InMemorySnapshotStore } from "./snapshots.js";

const HASHLINE_SNAPSHOT_STORE_KEY = Symbol.for("pi.fileops.hashline.snapshots");

type HashlineSnapshotGlobal = typeof globalThis & {
	[HASHLINE_SNAPSHOT_STORE_KEY]?: InMemorySnapshotStore;
};

const snapshotGlobal = globalThis as HashlineSnapshotGlobal;
if (!snapshotGlobal[HASHLINE_SNAPSHOT_STORE_KEY]) {
	snapshotGlobal[HASHLINE_SNAPSHOT_STORE_KEY] = new InMemorySnapshotStore();
}

export const HASHLINE_SNAPSHOTS = snapshotGlobal[HASHLINE_SNAPSHOT_STORE_KEY];

function absolutePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

function stripBom(text: string): { bom: string; text: string } {
	return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function textToDisplayLines(text: string): string[] {
	const normalized = normalizeToLf(text);
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

export function recordHashlineContiguous(
	path: string,
	startLine: number,
	lines: readonly string[],
	fullText?: string,
): string {
	return HASHLINE_SNAPSHOTS.recordContiguous(path, startLine, lines, fullText === undefined ? {} : { fullText });
}

export function recordHashlineSparse(
	path: string,
	entries: Iterable<readonly [number, string]>,
	fullText?: string,
): string {
	return HASHLINE_SNAPSHOTS.recordSparse(path, entries, fullText === undefined ? {} : { fullText });
}

export async function createHashlineEditAnchor(cwd: string, path: string): Promise<string> {
	const absolute = absolutePath(cwd, path);
	const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
	const text = normalizeToLf(rawText);
	const lines = textToDisplayLines(text);
	const tag = recordHashlineContiguous(absolute, 1, lines, text);
	return formatHashlineHeader(displayPath(cwd, absolute), tag);
}
