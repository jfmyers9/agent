import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeForkEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { shellQuote } from "./exec-command/shell/tokenize.ts";
import { TmuxLanePlacement } from "./shared/lane-placement.ts";

const DRAFT_FILE_ENV = "PI_FORK_SPLIT_DRAFT_FILE";
const SESSION_FILE_ENV = "PI_FORK_SPLIT_SESSION_FILE";

type ForkEnvironment = Record<string, string | undefined>;
type ForkResult = { cancel?: boolean; skipConversationRestore?: boolean };

function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

async function materializeSession(sessionManager: SessionManager, sessionFile: string): Promise<void> {
	const header = sessionManager.getHeader();
	if (!header) throw new Error("Forked session is missing its header");
	const contents = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
	await writeFile(sessionFile, `${contents}\n`, "utf8");
}

async function createForkedSession(ctx: ExtensionContext, entryId: string): Promise<string> {
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	if (!sourceSessionFile) throw new Error("Current session is not persisted");
	const selectedEntry = ctx.sessionManager.getEntry(entryId);
	if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
		throw new Error("Selected fork entry is not a user message");
	}

	const sessionDir = ctx.sessionManager.getSessionDir();
	let forkedSession: SessionManager;
	let forkedSessionFile: string | undefined;
	if (selectedEntry.parentId) {
		forkedSession = SessionManager.open(sourceSessionFile, sessionDir);
		forkedSessionFile = forkedSession.createBranchedSession(selectedEntry.parentId);
	} else {
		forkedSession = SessionManager.create(ctx.cwd, sessionDir);
		forkedSessionFile = forkedSession.newSession({ parentSession: sourceSessionFile });
	}

	if (!forkedSessionFile) throw new Error("Failed to create forked session");
	await materializeSession(forkedSession, forkedSessionFile);
	return forkedSessionFile;
}

export function forkedPiCommand(sessionFile: string): string {
	return `bash -lc ${shellQuote('exec pi --session "$1"')} pi-fork ${shellQuote(sessionFile)}`;
}

async function runTmux(pi: ExtensionAPI, args: string[]): Promise<string> {
	const result = await pi.exec("tmux", args, { timeout: 10_000 });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `tmux ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

export async function handleForkIntoTmuxSplit(
	pi: ExtensionAPI,
	event: SessionBeforeForkEvent,
	ctx: ExtensionContext,
	tmuxPane = process.env.TMUX_PANE,
): Promise<ForkResult | undefined> {
	if (event.position !== "before" || !ctx.hasUI) return;
	if (!tmuxPane) {
		ctx.ui.notify("Fork split failed: Pi is not running inside tmux.", "error");
		return { cancel: true };
	}

	let forkedSessionFile: string | undefined;
	let draftFile: string | undefined;
	try {
		const selectedEntry = ctx.sessionManager.getEntry(event.entryId);
		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Selected fork entry is not a user message");
		}

		forkedSessionFile = await createForkedSession(ctx, event.entryId);
		draftFile = join(tmpdir(), `pi-fork-${randomUUID()}.txt`);
		await writeFile(draftFile, extractUserMessageText(selectedEntry.message.content), "utf8");

		await new TmuxLanePlacement({ exec: (args) => runTmux(pi, args) }).place({
			placement: "split-pane",
			cwd: ctx.cwd,
			name: "fork",
			command: forkedPiCommand(forkedSessionFile),
			targetPane: tmuxPane,
			env: {
				[DRAFT_FILE_ENV]: draftFile,
				[SESSION_FILE_ENV]: forkedSessionFile,
			},
		});

		ctx.ui.notify("Fork opened in a tmux split.", "info");
	} catch (error) {
		await Promise.all([
			forkedSessionFile ? rm(forkedSessionFile, { force: true }) : Promise.resolve(),
			draftFile ? rm(draftFile, { force: true }) : Promise.resolve(),
		]);
		ctx.ui.notify(`Fork split failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	return { cancel: true };
}

export async function restoreForkDraft(ctx: ExtensionContext, env: ForkEnvironment = process.env): Promise<void> {
	const draftFile = env[DRAFT_FILE_ENV];
	const expectedSessionFile = env[SESSION_FILE_ENV];
	if (!(draftFile && expectedSessionFile)) return;
	delete env[DRAFT_FILE_ENV];
	delete env[SESSION_FILE_ENV];

	const activeSessionFile = ctx.sessionManager.getSessionFile();
	if (!activeSessionFile || resolve(activeSessionFile) !== resolve(expectedSessionFile)) return;

	try {
		const draft = await readFile(draftFile, "utf8");
		ctx.ui.setEditorText(draft);
		await rm(draftFile, { force: true });
	} catch (error) {
		ctx.ui.notify(`Could not restore fork draft: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

export default function forkSplitExtension(pi: ExtensionAPI) {
	pi.on("session_before_fork", (event, ctx) => handleForkIntoTmuxSplit(pi, event, ctx));
	pi.on("session_start", async (_event, ctx) => restoreForkDraft(ctx));
}
