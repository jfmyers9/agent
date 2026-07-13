import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_ITERATIONS = 8;
export const MAX_ITERATIONS = 50;
export const COMPLETION_MARKER = "<!-- PI_GOAL_COMPLETE -->";

const STATUS_KEY = "convergence-loop";
const MESSAGE_TYPE = "convergence-loop";

export interface LoopState {
	goal: string;
	iteration: number;
	maxIterations: number;
}

export type GoalCommand =
	| { action: "start"; goal: string; maxIterations: number }
	| { action: "status" }
	| { action: "stop" }
	| { action: "error"; message: string };

export interface AssistantOutcome {
	stopReason: string;
	text: string;
}

export function parseGoalCommand(rawArgs: string): GoalCommand {
	const args = rawArgs.trim();
	if (!args) return { action: "error", message: "Usage: /goal [--max N] <objective>" };
	if (args === "status") return { action: "status" };
	if (args === "stop") return { action: "stop" };

	const maxMatch = args.match(/^--max(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/);
	if (!maxMatch) return { action: "start", goal: args, maxIterations: DEFAULT_MAX_ITERATIONS };

	const value = Number(maxMatch[1]);
	if (!Number.isInteger(value) || value < 1 || value > MAX_ITERATIONS) {
		return { action: "error", message: `--max must be an integer from 1 to ${MAX_ITERATIONS}` };
	}

	const goal = maxMatch[2]?.trim();
	if (!goal) return { action: "error", message: "Usage: /goal [--max N] <objective>" };
	return { action: "start", goal, maxIterations: value };
}

export function getAssistantOutcome(messages: readonly AgentMessage[]): AssistantOutcome | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return {
			stopReason: message.stopReason,
			text: message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n"),
		};
	}
	return undefined;
}

export function hasCompletionMarker(text: string): boolean {
	return /<!--\s*PI_GOAL_COMPLETE\s*-->/i.test(text);
}

export function buildLoopInstructions(state: LoopState): string {
	return `You are running a bounded convergence loop for this user objective:

--- objective ---
${state.goal}
--- end objective ---

This is iteration ${state.iteration} of ${state.maxIterations}.
- Work autonomously toward the objective. Take concrete actions with tools; do not stop at a plan or a progress report.
- Reinspect the current state before acting and verify material changes with the narrowest useful checks.
- Correct failures and continue while useful work remains.
- Only when the objective is fully satisfied and relevant verification passes, include exactly ${COMPLETION_MARKER} in the final response.
- Never include that marker for partial progress, a blocked state, or an unverified result.`;
}

export default function convergenceLoopExtension(pi: ExtensionAPI) {
	let active: LoopState | undefined;
	let lastOutcome: AssistantOutcome | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, active ? `goal ${active.iteration}/${active.maxIterations}` : undefined);
	}

	function finish(ctx: ExtensionContext, message?: string, type: "info" | "warning" | "error" = "info"): void {
		active = undefined;
		lastOutcome = undefined;
		updateStatus(ctx);
		if (message) ctx.ui.notify(message, type);
	}

	async function handleCommand(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		const command = parseGoalCommand(rawArgs);
		if (command.action === "error") {
			ctx.ui.notify(command.message, "error");
			return;
		}
		if (command.action === "status") {
			ctx.ui.notify(
				active
					? `Goal loop ${active.iteration}/${active.maxIterations}: ${active.goal}`
					: "No convergence loop is active.",
				"info",
			);
			return;
		}
		if (command.action === "stop") {
			if (!active) {
				ctx.ui.notify("No convergence loop is active.", "info");
				return;
			}
			finish(ctx, ctx.isIdle() ? "Convergence loop stopped." : "Convergence loop stopped; current turn continues.");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current turn to finish, or stop it before starting a goal loop.", "warning");
			return;
		}

		active = {
			goal: command.goal,
			iteration: 1,
			maxIterations: command.maxIterations,
		};
		lastOutcome = undefined;
		updateStatus(ctx);
		try {
			pi.sendUserMessage(command.goal);
		} catch (error) {
			finish(ctx, `Failed to start goal loop: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	const command = {
		description: "Run a bounded autonomous loop until an objective converges",
		getArgumentCompletions: (prefix: string) =>
			["status", "stop", `--max ${DEFAULT_MAX_ITERATIONS} `]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: handleCommand,
	};
	pi.registerCommand("goal", command);
	pi.registerCommand("loop", command);

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildLoopInstructions(active)}` };
	});

	pi.on("agent_end", (event) => {
		if (active) lastOutcome = getAssistantOutcome(event.messages);
	});

	// agent_settled was added after the repository's 0.74 type dependency; deployed Pi is 0.80+.
	const onAgentSettled = pi.on as unknown as (
		event: "agent_settled",
		handler: (event: unknown, ctx: ExtensionContext) => void,
	) => void;
	onAgentSettled("agent_settled", (_event, ctx) => {
		if (!active) return;
		const outcome = lastOutcome;
		lastOutcome = undefined;
		if (!outcome) {
			finish(ctx, "Goal loop stopped because the run produced no assistant response.", "error");
			return;
		}
		if (outcome.stopReason !== "stop") {
			finish(ctx, `Goal loop stopped after agent result: ${outcome.stopReason}.`, "warning");
			return;
		}
		if (hasCompletionMarker(outcome.text)) {
			finish(ctx, `Goal converged in ${active.iteration} iteration${active.iteration === 1 ? "" : "s"}.`);
			return;
		}
		if (!ctx.isIdle()) {
			finish(ctx, "Convergence loop stopped because another agent run started.");
			return;
		}
		if (ctx.hasPendingMessages()) {
			finish(ctx, "Convergence loop stopped because another message is queued.");
			return;
		}
		if (active.iteration >= active.maxIterations) {
			finish(ctx, `Goal loop reached its ${active.maxIterations}-iteration limit without convergence.`, "warning");
			return;
		}

		active.iteration++;
		updateStatus(ctx);
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: "Continue the convergence loop. Reassess the current state and take the next concrete actions.",
				display: false,
				details: { ...active },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});
	pi.on("input", (event, ctx) => {
		if (active && event.source !== "extension") {
			finish(ctx, "Convergence loop stopped by new user input.");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		if (active) finish(ctx, "Convergence loop stopped after session-tree navigation.");
	});

	pi.on("session_start", (_event, ctx) => {
		finish(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		finish(ctx);
	});
}
