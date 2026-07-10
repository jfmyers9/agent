import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import execCommandExtension from "./index.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";

type Handler = (event?: any, ctx?: any) => any;

function createExtensionHarness() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const pi = {
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
		getActiveTools: () => [],
		setActiveTools() {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	} as any;
	execCommandExtension(pi);
	return { handlers, tools, sentMessages };
}

function emit(handlers: Map<string, Handler[]>, event: string, payload?: any, ctx?: any): void {
	for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
}

function baseContext() {
	return {
		hasUI: true,
		ui: { setStatus() {}, notify() {} },
		cwd: process.cwd(),
	};
}

async function waitForCondition(condition: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(50);
	}
	expect(condition()).toBe(true);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function processList(): string {
	return execSync("ps -axo pid,ppid,pgid,stat,command", { encoding: "utf8" });
}

test("uses process_id and suppresses a queued completion consumed by write_stdin", async () => {
	const { handlers, tools, sentMessages } = createExtensionHarness();
	const ctx = baseContext();
	emit(handlers, "session_start", undefined, ctx);
	try {
		const spawned = await tools
			.get("exec_command")
			.execute(
				"call-process-id",
				{ cmd: 'read line; printf "got:$line"', tty: true, yield_time_ms: 250, context_guard: false },
				undefined,
				undefined,
				ctx,
			);
		expect(spawned.details.process_id).toBeNumber();
		expect(spawned.details.session_id).toBeUndefined();

		const completed = await tools
			.get("write_stdin")
			.execute(
				"write-process-id",
				{ process_id: spawned.details.process_id, chars: "hello\n", yield_time_ms: 500 },
				undefined,
				undefined,
				ctx,
			);
		expect(completed.details.exit_code).toBe(0);
		expect(completed.details.output).toContain("got:hello");
		await Bun.sleep(300);
		expect(sentMessages).toHaveLength(0);
	} finally {
		emit(handlers, "session_shutdown", undefined, ctx);
	}
});

test("emits exactly one delayed follow-up for idle background completion", async () => {
	const { handlers, tools, sentMessages } = createExtensionHarness();
	const ctx = baseContext();
	emit(handlers, "session_start", undefined, ctx);
	try {
		const spawned = await tools
			.get("exec_command")
			.execute(
				"call-idle-completion",
				{ cmd: "sleep 0.3; printf DONE", yield_time_ms: 250, context_guard: false },
				undefined,
				undefined,
				ctx,
			);
		expect(spawned.details.process_id).toBeNumber();
		await waitForCondition(() => sentMessages.length === 1);
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(sentMessages[0]?.message.details.process_id).toBe(spawned.details.process_id);
		expect(sentMessages[0]?.message.details.output).toBe("DONE");
	} finally {
		emit(handlers, "session_shutdown", undefined, ctx);
	}
});

test("does not wake the agent for background completion during an active turn", async () => {
	const { handlers, tools, sentMessages } = createExtensionHarness();
	const ctx = baseContext();
	emit(handlers, "session_start", undefined, ctx);
	emit(handlers, "agent_start", undefined, ctx);
	try {
		const spawned = await tools
			.get("exec_command")
			.execute(
				"call-active-turn",
				{ cmd: "sleep 0.3; printf ACTIVE_OK", yield_time_ms: 250, context_guard: false },
				undefined,
				undefined,
				ctx,
			);
		expect(spawned.details.process_id).toBeNumber();
		await Bun.sleep(700);
		expect(sentMessages).toHaveLength(0);

		const polled = await tools
			.get("write_stdin")
			.execute(
				"poll-active-turn",
				{ process_id: spawned.details.process_id, chars: "", yield_time_ms: 1000 },
				undefined,
				undefined,
				ctx,
			);
		expect(polled.details.output).toContain("ACTIVE_OK");
	} finally {
		emit(handlers, "agent_end", undefined, ctx);
		emit(handlers, "session_shutdown", undefined, ctx);
	}
});

test("Escape aborts a foreground exec_command", async () => {
	const { handlers, tools } = createExtensionHarness();
	let terminalInputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let abortCalled = false;
	const controller = new AbortController();
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus() {},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			onTerminalInput(handler: typeof terminalInputHandler) {
				terminalInputHandler = handler;
				return () => {
					terminalInputHandler = undefined;
				};
			},
		},
		cwd: process.cwd(),
		abort() {
			abortCalled = true;
			controller.abort();
		},
	};
	emit(handlers, "session_start", undefined, ctx);
	emit(
		handlers,
		"tool_execution_start",
		{ toolName: "exec_command", toolCallId: "call-escape", args: { cmd: "sleep 60" } },
		ctx,
	);
	try {
		const execution = tools
			.get("exec_command")
			.execute(
				"call-escape",
				{ cmd: "sleep 60", yield_time_ms: 120_000, context_guard: false },
				controller.signal,
				undefined,
				ctx,
			);
		await waitForCondition(() => terminalInputHandler !== undefined);
		expect(terminalInputHandler?.("\x1b")?.consume).toBe(true);
		const result = await execution;
		expect(abortCalled).toBe(true);
		expect(result.details.cancelled).toBe(true);
		expect(notifications).toContainEqual({ message: "Interrupting foreground exec_command...", type: "info" });
	} finally {
		emit(handlers, "tool_execution_end", { toolName: "exec_command", toolCallId: "call-escape" }, ctx);
		emit(handlers, "session_shutdown", undefined, ctx);
	}
});

test("shutdown terminates descendants that escaped the shell process group", async () => {
	const marker = `exec-command-descendant-${process.pid}-${Date.now()}`;
	const sessions = createExecSessionManager({ defaultExecYieldTimeMs: 250 });
	const childCode = [
		"import signal,time",
		"signal.signal(signal.SIGTERM, signal.SIG_IGN)",
		"signal.signal(signal.SIGHUP, signal.SIG_IGN)",
		"time.sleep(30)",
	].join("; ");
	const parentCode = [
		"import subprocess,time",
		`p=subprocess.Popen(["python3","-c",${JSON.stringify(childCode)},${JSON.stringify(`${marker}-child`)}], start_new_session=True)`,
		'print("child="+str(p.pid), flush=True)',
		"time.sleep(30)",
	].join("; ");
	try {
		const result = await sessions.exec(
			{ cmd: `python3 -c ${shellQuote(parentCode)} ${shellQuote(`${marker}-parent`)}`, yield_time_ms: 250 },
			process.cwd(),
		);
		expect(result.process_id).toBeNumber();
		let output = result.output;
		for (let attempt = 0; !output.includes("child=") && attempt < 12; attempt += 1) {
			output += (await sessions.write({ process_id: result.process_id!, yield_time_ms: 250 })).output;
		}
		expect(output).toContain("child=");
		expect(processList()).toContain(`${marker}-child`);
		sessions.shutdown();
		await waitForCondition(() => !processList().includes(marker));
	} finally {
		sessions.shutdown();
		try {
			execSync(`pkill -KILL -f ${shellQuote(marker)}`);
		} catch {
			// Process already exited.
		}
	}
});
