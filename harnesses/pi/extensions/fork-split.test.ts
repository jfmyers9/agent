import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import forkSplitExtension, { handleForkIntoTmuxSplit, restoreForkDraft } from "./fork-split";

const tempPaths: string[] = [];

afterEach(async () => {
	await Promise.all(tempPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("fork split extension", () => {
	test("opens the selected fork in a tmux split without replacing the parent", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-fork-split-test-"));
		tempPaths.push(sessionDir);
		const source = SessionManager.create("/repo", sessionDir);
		const firstUserId = source.appendMessage({ role: "user", content: "first", timestamp: 1 });
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			stopReason: "stop",
			timestamp: 2,
		} as any);
		const selectedId = source.appendMessage({ role: "user", content: "revise this", timestamp: 3 });
		const sourceFile = source.getSessionFile()!;

		const handlers = new Map<string, (event: any, ctx: any) => any>();
		const tmuxCalls: string[][] = [];
		const notifications: Array<[string, string]> = [];
		const pi = {
			on(name: string, handler: (event: any, ctx: any) => any) {
				handlers.set(name, handler);
			},
			async exec(command: string, args: string[]) {
				expect(command).toBe("tmux");
				tmuxCalls.push(args);
				if (args[0] === "display-message" && args.at(-1) === "#S") return { code: 0, stdout: "dev\n", stderr: "" };
				if (args[0] === "display-message" && args.at(-1) === "#S:#I") {
					return { code: 0, stdout: "dev:1\n", stderr: "" };
				}
				if (args[0] === "split-window") return { code: 0, stdout: "%9\n", stderr: "" };
				throw new Error(`Unexpected tmux call: ${args.join(" ")}`);
			},
		};
		forkSplitExtension(pi as any);
		expect(handlers.has("session_before_fork")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);

		const result = await handleForkIntoTmuxSplit(
			pi as any,
			{ type: "session_before_fork", entryId: selectedId, position: "before" },
			{
				hasUI: true,
				cwd: "/repo",
				sessionManager: source,
				ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
			},
			"%1",
		);

		expect(result).toEqual({ cancel: true });
		expect(source.getSessionFile()).toBe(sourceFile);
		const splitCall = tmuxCalls.find((args) => args[0] === "split-window")!;
		expect(splitCall).toContain("%1");
		const childEnv = splitCall.find((arg) => arg.startsWith("PI_FORK_SPLIT_SESSION_FILE="))!;
		const draftEnv = splitCall.find((arg) => arg.startsWith("PI_FORK_SPLIT_DRAFT_FILE="))!;
		const childFile = childEnv.slice(childEnv.indexOf("=") + 1);
		const draftFile = draftEnv.slice(draftEnv.indexOf("=") + 1);
		const child = SessionManager.open(childFile, sessionDir);

		expect(child.getHeader()?.parentSession).toBe(sourceFile);
		expect(child.getEntries().map((entry) => entry.id)).toContain(firstUserId);
		expect(child.getEntries().map((entry) => entry.id)).not.toContain(selectedId);
		expect(await readFile(draftFile, "utf8")).toBe("revise this");
		expect(notifications).toContainEqual(["Fork opened in a tmux split.", "info"]);

		tempPaths.push(draftFile);
	});

	test("forks the first user prompt into an empty persisted child", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-fork-root-test-"));
		tempPaths.push(sessionDir);
		const source = SessionManager.create("/repo", sessionDir);
		const selectedId = source.appendMessage({ role: "user", content: "root prompt", timestamp: 1 });
		const sourceFile = source.getSessionFile()!;
		const tmuxCalls: string[][] = [];
		const pi = {
			async exec(_command: string, args: string[]) {
				tmuxCalls.push(args);
				if (args[0] === "display-message" && args.at(-1) === "#S") return { code: 0, stdout: "dev\n", stderr: "" };
				if (args[0] === "display-message" && args.at(-1) === "#S:#I") {
					return { code: 0, stdout: "dev:1\n", stderr: "" };
				}
				return { code: 0, stdout: "%9\n", stderr: "" };
			},
		};

		const result = await handleForkIntoTmuxSplit(
			pi as any,
			{ type: "session_before_fork", entryId: selectedId, position: "before" },
			{
				hasUI: true,
				cwd: "/repo",
				sessionManager: source,
				ui: { notify: () => {} },
			} as any,
			"%1",
		);

		expect(result).toEqual({ cancel: true });
		const splitCall = tmuxCalls.find((args) => args[0] === "split-window")!;
		const childEnv = splitCall.find((arg) => arg.startsWith("PI_FORK_SPLIT_SESSION_FILE="))!;
		const draftEnv = splitCall.find((arg) => arg.startsWith("PI_FORK_SPLIT_DRAFT_FILE="))!;
		const childFile = childEnv.slice(childEnv.indexOf("=") + 1);
		const draftFile = draftEnv.slice(draftEnv.indexOf("=") + 1);
		const child = SessionManager.open(childFile, sessionDir);

		expect(child.getHeader()?.parentSession).toBe(sourceFile);
		expect(child.getEntries()).toEqual([]);
		expect(await readFile(draftFile, "utf8")).toBe("root prompt");
		tempPaths.push(draftFile);
	});

	test("restores the selected prompt into the child editor once", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-fork-restore-test-"));
		tempPaths.push(sessionDir);
		const session = SessionManager.create("/repo", sessionDir);
		const sessionFile = session.getSessionFile()!;
		const draftFile = join(sessionDir, "draft.txt");
		await Bun.write(draftFile, "edit before resubmitting");
		const editorText: string[] = [];
		const env = {
			PI_FORK_SPLIT_DRAFT_FILE: draftFile,
			PI_FORK_SPLIT_SESSION_FILE: sessionFile,
		};

		await restoreForkDraft(
			{
				sessionManager: session,
				ui: {
					setEditorText: (text: string) => editorText.push(text),
					notify: () => {},
				},
			} as any,
			env,
		);

		expect(editorText).toEqual(["edit before resubmitting"]);
		expect(env.PI_FORK_SPLIT_DRAFT_FILE).toBeUndefined();
		expect(env.PI_FORK_SPLIT_SESSION_FILE).toBeUndefined();
		expect(await Bun.file(draftFile).exists()).toBe(false);
	});

	test("cancels instead of replacing the session when tmux is unavailable", async () => {
		const notifications: Array<[string, string]> = [];

		const result = await handleForkIntoTmuxSplit(
			{} as any,
			{ type: "session_before_fork", entryId: "user", position: "before" },
			{
				hasUI: true,
				ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
			},
			"",
		);

		expect(result).toEqual({ cancel: true });
		expect(notifications).toEqual([["Fork split failed: Pi is not running inside tmux.", "error"]]);
	});
});
