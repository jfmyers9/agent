import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextUsage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { BasePromptTraceResult } from "./base-trace/index.js";
import { attributeBasePrompt, extractBaseLines, extractContributions } from "./base-trace/index.js";
import type { LoadedExtension } from "./base-trace/types.js";
import { DisableMode } from "./enums.js";
import { buildToolDefinitionsSection, estimateTokens, parseSystemPrompt } from "./parser.js";
import { showReport } from "./report-view.js";
import { loadAllSkills } from "./skills.js";
import { applyChanges, loadSettings } from "./skills-persistence.js";
import { createToolToggleController, loadToolToggleConfig } from "./tool-toggles.js";
import type { SessionUsageCategory, SessionUsageData } from "./types.js";

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");

/**
 * Resolve the agent directory, matching pi's own resolution logic:
 * 1. Check PI_CODING_AGENT_DIR environment variable
 * 2. Fall back to ~/.pi/agent
 */
function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") {
			return os.homedir();
		}
		if (envDir.startsWith("~/")) {
			return path.join(os.homedir(), envDir.slice(2));
		}
		return envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

const IMAGE_TOKEN_ESTIMATE = 1200;

function measuredSessionTokens(usage: ContextUsage | undefined): number | undefined {
	if (typeof usage?.tokens !== "number") {
		return undefined;
	}

	return usage.tokens > 0 ? usage.tokens : undefined;
}

function contentRecords(content: unknown): readonly Record<string, unknown>[] {
	return Array.isArray(content)
		? content.filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
		: [];
}

function estimateContentTokens(content: unknown): number {
	if (typeof content === "string") {
		return estimateTokens(content);
	}

	let tokens = 0;
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			tokens += estimateTokens(part.text);
		} else if (part.type === "image") {
			tokens += IMAGE_TOKEN_ESTIMATE;
		} else {
			tokens += estimateTokens(JSON.stringify(part));
		}
	}
	return tokens;
}

function addCategory(categories: Map<string, number>, label: string, tokens: number): void {
	if (tokens <= 0) {
		return;
	}
	categories.set(label, (categories.get(label) ?? 0) + tokens);
}

function estimateToolCallTokens(part: Record<string, unknown>): number {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});
	return estimateTokens(`${name}${input}`);
}

function addAssistantCategories(categories: Map<string, number>, content: unknown): void {
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			addCategory(categories, "Assistant", estimateTokens(part.text));
		} else if (part.type === "thinking" && typeof part.thinking === "string") {
			addCategory(categories, "Thinking", estimateTokens(part.thinking));
		} else if (part.type === "toolCall") {
			addCategory(categories, "Assistant", estimateToolCallTokens(part));
		}
	}
}

function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	const pushCurrent = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (const char of command) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char) || char === "|" || char === ";") {
			pushCurrent();
			continue;
		}
		current += char;
	}

	pushCurrent();
	return tokens;
}

function shellCommandName(command: string): string | undefined {
	const tokens = shellTokens(command.trim());
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token || token.includes("=")) {
			continue;
		}
		if (token === "command" || token === "builtin" || token === "noglob" || token === "time") {
			continue;
		}
		if (token === "sudo" || token === "env") {
			continue;
		}
		const name = token.replace(/\\/g, "/").split("/").pop();
		if (name === "bash" || name === "zsh" || name === "sh") {
			const script = tokens[index + 2];
			if ((tokens[index + 1] === "-c" || tokens[index + 1] === "-lc") && script) {
				return shellCommandName(script) ?? name;
			}
		}
		return name;
	}
	return undefined;
}

function toolCallCommands(messages: readonly unknown[]): Map<string, string> {
	const commands = new Map<string, string>();

	for (const message of messages) {
		if (!message || typeof message !== "object") {
			continue;
		}
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") {
			continue;
		}
		for (const part of contentRecords(record.content)) {
			if (part.type !== "toolCall" || part.name !== "exec_command" || typeof part.id !== "string") {
				continue;
			}
			const args = part.arguments;
			if (args && typeof args === "object" && typeof (args as Record<string, unknown>).cmd === "string") {
				commands.set(part.id, (args as Record<string, string>).cmd);
			}
		}
	}

	return commands;
}

function commandFromToolResultContent(content: unknown): string | undefined {
	for (const part of contentRecords(content)) {
		if (part.type !== "text" || typeof part.text !== "string") {
			continue;
		}
		const match = part.text.match(/^Command:\s*(.+)$/m);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return undefined;
}

function toolResultLabel(record: Record<string, unknown>, commandsByToolCallId: Map<string, string>): string {
	const toolName = record.toolName;
	const name = typeof toolName === "string" && toolName.trim() ? toolName.trim() : "unknown";
	if (name === "exec_command") {
		const toolCallCommand =
			typeof record.toolCallId === "string" ? commandsByToolCallId.get(record.toolCallId) : undefined;
		const command = toolCallCommand ?? commandFromToolResultContent(record.content);
		const commandName = command ? shellCommandName(command) : undefined;
		if (commandName) {
			return `Tool result: exec_command(${commandName})`;
		}
	}
	return `Tool result: ${name}`;
}

function estimateRawSessionCategories(messages: readonly unknown[]): SessionUsageCategory[] {
	const categories = new Map<string, number>();
	const commandsByToolCallId = toolCallCommands(messages);

	for (const message of messages) {
		if (!message || typeof message !== "object") {
			continue;
		}
		const record = message as Record<string, unknown>;

		if (record.role === "user" || record.role === "custom") {
			addCategory(categories, "User prompts", estimateContentTokens(record.content));
		} else if (record.role === "assistant") {
			addAssistantCategories(categories, record.content);
		} else if (record.role === "toolResult") {
			addCategory(categories, toolResultLabel(record, commandsByToolCallId), estimateContentTokens(record.content));
		} else if (record.role === "bashExecution") {
			addCategory(categories, "User prompts", estimateTokens(`${record.command ?? ""}${record.output ?? ""}`));
		} else if (record.role === "branchSummary" || record.role === "compactionSummary") {
			addCategory(categories, "Session summaries", estimateTokens(String(record.summary ?? "")));
		}
	}

	return [...categories.entries()].map(([label, tokens]) => ({ label, tokens }));
}

function allocateProportionally(values: readonly number[], total: number): number[] {
	if (total <= 0) {
		return values.map(() => 0);
	}

	const sourceTotal = values.reduce((sum, value) => sum + value, 0);
	if (sourceTotal <= 0) {
		return values.map(() => 0);
	}

	const raw = values.map((value) => (value / sourceTotal) * total);
	const allocated = raw.map(Math.floor);
	let remaining = total - allocated.reduce((sum, value) => sum + value, 0);
	const largestRemainders = raw
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((left, right) => right.remainder - left.remainder);

	for (let index = 0; index < largestRemainders.length && remaining > 0; index++, remaining--) {
		const slot = largestRemainders[index];
		if (slot) {
			allocated[slot.index] = (allocated[slot.index] ?? 0) + 1;
		}
	}

	return allocated;
}

function scaleCategoriesToUsage(categories: SessionUsageCategory[], tokens: number): SessionUsageCategory[] {
	if (categories.length === 0) {
		return tokens > 0 ? [{ label: "Session", tokens }] : [];
	}

	const allocated = allocateProportionally(
		categories.map((category) => category.tokens),
		Math.round(tokens),
	);

	return categories
		.map((category, index) => ({ label: category.label, tokens: allocated[index] ?? 0 }))
		.filter((category) => category.tokens > 0);
}

export function buildSessionUsageData(ctx: ExtensionCommandContext): SessionUsageData | undefined {
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const rawCategories = estimateRawSessionCategories(context.messages);
	const estimatedTokens = rawCategories.reduce((total, category) => total + category.tokens, 0);
	const usage = ctx.getContextUsage();
	const measuredTokens = measuredSessionTokens(usage);
	const sessionTokens = measuredTokens ?? estimatedTokens;

	if (sessionTokens <= 0) {
		return undefined;
	}

	return {
		tokens: sessionTokens,
		estimated: measuredTokens === undefined,
		categories: scaleCategoriesToUsage(rawCategories, sessionTokens),
	};
}

const extension: ExtensionFactory = (pi) => {
	const toolToggles = createToolToggleController(pi, loadToolToggleConfig(CONFIG_PATH).disabledTools, CONFIG_PATH);
	toolToggles.install();

	pi.registerCommand("token-burden", {
		description: "Show token budget breakdown and manage skills",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			const parsed = parseSystemPrompt(prompt);

			// Add tool definitions section (function schemas sent via tool-calling API)
			const allTools = pi.getAllTools();
			const activeTools = pi.getActiveTools();
			const toolSection = buildToolDefinitionsSection(allTools, activeTools);
			if (toolSection) {
				parsed.sections.push(toolSection);
				parsed.totalTokens += toolSection.tokens;
				parsed.totalChars += toolSection.chars;
			}

			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
			const sessionUsage = buildSessionUsageData(ctx);

			if (!ctx.hasUI) {
				return;
			}

			const agentDir = getAgentDir();
			const settingsPath = path.join(agentDir, "settings.json");
			const settings = loadSettings(settingsPath);
			const { skills, byName } = loadAllSkills(settings, undefined, agentDir);

			const onRunTrace = async (): Promise<BasePromptTraceResult> => {
				const sm = SettingsManager.create(process.cwd(), agentDir);
				const configuredPaths = sm.getExtensionPaths();
				const { extensions, errors: loadErrors } = await discoverAndLoadExtensions(
					configuredPaths,
					process.cwd(),
					agentDir,
				);

				const contributions = extractContributions(extensions as unknown as LoadedExtension[]);

				const baseSection = parsed.sections.find((s) => s.label.startsWith("Base"));
				const baseText = baseSection?.content ?? "";
				const { toolLines, guidelineLines } = extractBaseLines(baseText);
				const baseTokens = estimateTokens(baseText);

				const { buckets, evidence } = attributeBasePrompt(
					toolLines,
					guidelineLines,
					contributions,
					baseTokens,
					estimateTokens,
				);

				const traceErrors = loadErrors.map((e) => ({
					source: e.path,
					message: e.error,
				}));

				return {
					fingerprint: extensions
						.map((e) => e.path)
						.toSorted()
						.join("|"),
					generatedAt: new Date().toISOString(),
					baseTokens,
					buckets,
					evidence,
					errors: traceErrors,
				};
			};

			await showReport(
				parsed,
				contextWindow,
				ctx,
				skills,
				(result) => {
					if (!result.applied || result.changes.size === 0) {
						return true;
					}

					try {
						applyChanges(result.changes, byName, settingsPath, agentDir);

						const parts: string[] = [];
						const enabledCount = [...result.changes.values()].filter((v) => v === DisableMode.Enabled).length;
						const hiddenCount = [...result.changes.values()].filter((v) => v === DisableMode.Hidden).length;
						const disabledCount = [...result.changes.values()].filter((v) => v === DisableMode.Disabled).length;

						if (enabledCount > 0) {
							parts.push(`${enabledCount} enabled`);
						}
						if (hiddenCount > 0) {
							parts.push(`${hiddenCount} hidden`);
						}
						if (disabledCount > 0) {
							parts.push(`${disabledCount} disabled`);
						}

						ctx.ui.notify(
							`Skills updated: ${parts.join(", ")}. Use /reload or restart for changes to take effect.`,
							"info",
						);
						return true;
					} catch (error) {
						const msg = error instanceof Error ? error.message : "Unknown error";
						ctx.ui.notify(`Failed to save settings: ${msg}`, "error");
						return false;
					}
				},
				onRunTrace,
				toolToggles.setToolActive,
				sessionUsage,
			);
		},
	});
};

export default extension;
