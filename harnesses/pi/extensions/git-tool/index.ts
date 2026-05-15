import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GitToolMode = "graphite" | "git-spice" | "main" | "none";

type GitToolExtensionOptions = {
	readGitToolConfig?: () => string | undefined;
};

type ResourceDiscovery = {
	skillPaths?: string[];
};

type ToolCallEventLike = {
	toolName: string;
	input?: unknown;
	args?: unknown;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const GRAPHITE_SKILLS_DIR = join(EXTENSION_DIR, "skill-resources", "graphite");
const GIT_SPICE_SKILLS_DIR = join(EXTENSION_DIR, "skill-resources", "git-spice");

export const GIT_TOOL_MAIN_PROMPT_ADDENDUM = `## Git tool strategy: current branch

This repository is configured with \`agents.git-tool=main\`. Do not assume a stacked-branch workflow. When the user asks you to commit or push, commit or push on the currently checked-out branch unless the user explicitly asks you to create or switch branches.`;

export const GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM = `## Git tool strategy: Graphite

This repository is configured with \`agents.git-tool=graphite\`. Use Graphite for stacked-branch workflows. Use the \`submit\`, \`sync\`, \`restack\`, and \`stack\` skills for pushing, creating or updating PRs, syncing with trunk, rebasing/restacking, branch creation, stack navigation, and stack inspection.

Do not use raw \`git push\`, \`git rebase\`, \`git checkout -b\`, or \`gh pr create\` for stack workflows. Ordinary \`git status\`, \`git add\`, and \`git commit\` remain allowed when they do not replace a Graphite stack operation.`;

export const GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM = `## Git tool strategy: Git-Spice

This repository is configured with \`agents.git-tool=git-spice\`. Use Git-Spice for stacked-branch workflows. Use the \`submit\`, \`sync\`, \`restack\`, and \`stack\` skills for pushing, creating or updating Change Requests, syncing with trunk, rebasing/restacking, branch creation, stack navigation, and stack inspection.

Do not use raw \`git push\`, \`git rebase\`, \`git checkout -b\`, or \`gh pr create\` for stack workflows. Ordinary \`git status\`, \`git add\`, and \`git commit\` remain allowed when they do not replace a Git-Spice stack operation.`;

export default function gitToolExtension(pi: ExtensionAPI, options: GitToolExtensionOptions = {}) {
	const readGitToolConfig = options.readGitToolConfig ?? defaultReadGitToolConfig;
	const configuredMode = () => parseGitToolMode(readGitToolConfig());

	pi.on("resources_discover", () => gitToolResources(configuredMode()));

	pi.on("before_agent_start", (event) => {
		const systemPrompt = appendGitToolPrompt(event.systemPrompt, configuredMode());
		if (systemPrompt === event.systemPrompt) return;
		return { systemPrompt };
	});

	pi.on("tool_call", gitToolToolCallBlock);
}

export function parseGitToolMode(value: string | undefined): GitToolMode {
	switch (value) {
		case "graphite":
		case "git-spice":
		case "main":
		case "none":
			return value;
		default:
			return "none";
	}
}

export function gitToolResources(mode: GitToolMode): ResourceDiscovery {
	switch (mode) {
		case "graphite":
			return { skillPaths: [GRAPHITE_SKILLS_DIR] };
		case "git-spice":
			return { skillPaths: [GIT_SPICE_SKILLS_DIR] };
		case "main":
		case "none":
			return {};
	}
}

export function appendGitToolPrompt(systemPrompt: string, mode: GitToolMode): string {
	const addendum = gitToolPromptAddendum(mode);
	if (!addendum) return systemPrompt;
	if (systemPrompt.includes(addendum)) return systemPrompt;
	return `${systemPrompt}\n\n${addendum}`;
}

export function gitToolToolCallBlock(_event: ToolCallEventLike): undefined {
	return undefined;
}

function gitToolPromptAddendum(mode: GitToolMode): string | undefined {
	switch (mode) {
		case "graphite":
			return GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM;
		case "git-spice":
			return GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM;
		case "main":
			return GIT_TOOL_MAIN_PROMPT_ADDENDUM;
		case "none":
			return undefined;
	}
}

function defaultReadGitToolConfig(): string | undefined {
	return gitOutput(["config", "--get", "agents.git-tool"]);
}

function gitOutput(args: string[]): string | undefined {
	return commandOutput("git", args);
}

function commandOutput(command: string, args: string[]): string | undefined {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split("\n")[0];
	} catch {
		return undefined;
	}
}
