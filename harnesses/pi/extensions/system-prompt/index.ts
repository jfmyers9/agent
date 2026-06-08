import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Mustache, { type TemplateSpans } from "mustache";

const SYSTEM_PROMPT_TEMPLATE = readFileSync(new URL("./SYSTEM_PROMPT.md.mustache", import.meta.url), "utf8").trimEnd();

type EnvironmentContextEnvironment = {
	id?: string;
	cwd: string;
	shell?: string;
};

type EnvironmentContextOptions = {
	environments?: EnvironmentContextEnvironment[];
	currentDate?: string | null;
	timezone?: string | null;
	shell?: string;
};

type EnvironmentContextEnvironmentView = {
	id: string;
	cwd: string;
	shell: string;
};

type EnvironmentContextView = {
	hasSingleEnvironment: boolean;
	singleEnvironment: EnvironmentContextEnvironmentView | null;
	hasMultipleEnvironments: boolean;
	environments: EnvironmentContextEnvironmentView[];
	currentDate: string | null;
	timezone: string | null;
};

type SystemPromptSkill = {
	name: string;
	description: string;
	filePath?: string;
	disableModelInvocation?: boolean;
};

type SystemPromptContextFile = {
	path: string;
	content: string;
};

type SystemPromptBuildOptions = {
	customPrompt?: string | null;
	selectedTools?: string[];
	promptGuidelines?: string[];
	appendSystemPrompt?: string | null;
	cwd: string;
	contextFiles?: SystemPromptContextFile[];
	skills?: SystemPromptSkill[];
	environmentContext?: EnvironmentContextOptions;
	now?: Date;
};

type ToolFlags = {
	hasBash: boolean;
	hasExecCommand: boolean;
	hasFind: boolean;
	hasGrep: boolean;
	hasRead: boolean;
	hasSearch: boolean;
	hasShellTool: boolean;
};

type BeforeAgentStartPromptEvent = {
	systemPrompt: string;
	systemPromptOptions: Partial<SystemPromptBuildOptions> & { cwd?: string };
};

export default async function systemPromptExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const promptEvent = event as BeforeAgentStartPromptEvent;
		return {
			systemPrompt: buildSystemPrompt(promptEvent.systemPrompt, {
				...promptEvent.systemPromptOptions,
				cwd: ctx.cwd,
			}),
		};
	});
}

export function buildSystemPrompt(original: string, options: SystemPromptBuildOptions): string {
	const {
		customPrompt,
		selectedTools,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const now = options.now ?? new Date();
	const date = formatDate(now);

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const tools = selectedTools ?? ["read", "bash", "edit", "write"];

	const toolFlags = buildToolFlags(tools);
	const hasSkillTool = tools.includes("skill");

	const readmePath = original.match(/- Main documentation: (.+)/)?.[1] ?? null;
	const docsPath = original.match(/- Additional docs: (.+)/)?.[1] ?? null;
	const examplesPath = original.match(/- Examples: (.+)/)?.[1] ?? null;
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);

	return renderTemplate("SYSTEM_PROMPT.md.mustache", SYSTEM_PROMPT_TEMPLATE, {
		appendSystemPrompt: appendSystemPrompt ?? null,
		contextFiles,
		customPrompt: customPrompt ?? null,
		docsPath: docsPath ?? "null",
		environmentContext: buildEnvironmentContextView({
			currentDate: date,
			timezone: currentTimezone(),
			...options.environmentContext,
			environments: options.environmentContext?.environments ?? [
				{
					cwd: promptCwd,
					shell: options.environmentContext?.shell ?? defaultShellName(),
				},
			],
		}),
		examplesPath: examplesPath ?? "null",
		...toolFlags,
		hasContextFiles: contextFiles.length > 0,
		includeSkills: (hasSkillTool || toolFlags.hasRead) && visibleSkills.length > 0,
		promptGuidelines: uniqueNonEmptyLines(promptGuidelines ?? []),
		readmePath: readmePath ?? "null",
		readSkillFallback: !hasSkillTool && toolFlags.hasRead,
		skills: visibleSkills,
		skillToolActive: hasSkillTool,
	});
}

function buildToolFlags(tools: string[]): ToolFlags {
	const hasBash = tools.includes("bash");
	const hasExecCommand = tools.includes("exec_command");
	const hasSearch = tools.includes("search");

	return {
		hasBash,
		hasExecCommand,
		hasFind: tools.includes("find"),
		hasGrep: tools.includes("grep") && !hasSearch,
		hasRead: tools.includes("read"),
		hasSearch,
		hasShellTool: hasBash || hasExecCommand,
	};
}

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

function currentTimezone(): string | null {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
}

function defaultShellName(): string {
	const shell = process.env.SHELL || process.env.ComSpec || "unknown";
	const parts = shell.split(/[\\/]/).filter(Boolean);

	return parts.at(-1) ?? shell;
}

function buildEnvironmentContextView(context: EnvironmentContextOptions): EnvironmentContextView {
	const defaultShell = context.shell ?? defaultShellName();
	const environments = (context.environments ?? []).map((environment) => ({
		id: environment.id ?? "",
		cwd: environment.cwd,
		shell: environment.shell ?? defaultShell,
	}));

	return {
		hasSingleEnvironment: environments.length === 1,
		singleEnvironment: environments.length === 1 ? environments[0] : null,
		hasMultipleEnvironments: environments.length > 1,
		environments,
		currentDate: context.currentDate || null,
		timezone: context.timezone || null,
	};
}

function uniqueNonEmptyLines(lines: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const line of lines) {
		const normalized = line.trim();
		if (normalized.length === 0 || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		result.push(normalized);
	}

	return result;
}

type TemplateView = Record<string, unknown>;
type TemplateToken = TemplateSpans[number];

function renderTemplate(templateName: string, template: string, view: TemplateView): string {
	const tokens = Mustache.parse(template);
	assertTemplateValues(templateName, tokens, [view]);

	return Mustache.render(template, view, undefined, { escape: escapeXml });
}

function assertTemplateValues(templateName: string, tokens: TemplateSpans, contexts: unknown[]): void {
	for (const token of tokens) {
		const [type, name] = token;

		if (type === "name" || type === "&") {
			const value = lookupTemplateValue(contexts, name);
			if (!value.exists) {
				throw new Error(`Missing ${templateName} value for {{${name}}}`);
			}
		}

		if (type === "#" || type === "^") {
			const value = lookupTemplateValue(contexts, name);
			if (!value.exists) {
				throw new Error(`Missing ${templateName} section value for {{#${name}}}`);
			}

			const nestedTokens = getNestedTokens(token);
			if (nestedTokens) {
				assertSectionTemplateValues(templateName, nestedTokens, contexts, value.value, type);
			}
		}
	}
}

function assertSectionTemplateValues(
	templateName: string,
	tokens: TemplateSpans,
	contexts: unknown[],
	sectionValue: unknown,
	sectionType: "#" | "^",
): void {
	if (sectionType === "^") {
		if (!isTruthyMustacheValue(sectionValue)) {
			assertTemplateValues(templateName, tokens, contexts);
		}
		return;
	}

	if (Array.isArray(sectionValue)) {
		for (const item of sectionValue) {
			assertTemplateValues(templateName, tokens, [...contexts, item]);
		}
		return;
	}

	if (sectionValue && typeof sectionValue === "object") {
		assertTemplateValues(templateName, tokens, [...contexts, sectionValue]);
		return;
	}

	if (sectionValue) {
		assertTemplateValues(templateName, tokens, contexts);
	}
}

function isTruthyMustacheValue(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.length > 0;
	}

	return Boolean(value);
}

function getNestedTokens(token: TemplateToken): TemplateSpans | undefined {
	const nested = token[4];

	return Array.isArray(nested) ? (nested as TemplateSpans) : undefined;
}

function lookupTemplateValue(contexts: unknown[], name: string): { exists: boolean; value?: unknown } {
	if (name === ".") {
		const value = contexts.at(-1);
		return { exists: value !== undefined, value };
	}

	for (let i = contexts.length - 1; i >= 0; i--) {
		const context = contexts[i];
		const value = lookupInContext(context, name);

		if (value.exists) {
			return value;
		}
	}

	return { exists: false };
}

function lookupInContext(context: unknown, name: string): { exists: boolean; value?: unknown } {
	if (!context || typeof context !== "object") {
		return { exists: false };
	}

	let value: unknown = context;
	for (const part of name.split(".")) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
			return { exists: false };
		}

		value = (value as Record<string, unknown>)[part];
	}

	return { exists: true, value };
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
