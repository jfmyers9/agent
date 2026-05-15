import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LOCAL_CONTEXT_FILENAMES = ["AGENTS.local.md", "CLAUDE.local.md"] as const;
const SECTION_TITLE = "Local Project Context";

type LocalContextFile = {
	path: string;
	content: string;
};

function candidateDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = resolve(cwd);
	const root = parse(current).root;

	while (true) {
		dirs.unshift(current);
		if (current === root) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return dirs;
}

function loadLocalContextFiles(cwd: string): LocalContextFile[] {
	const files: LocalContextFile[] = [];
	for (const dir of candidateDirs(cwd)) {
		for (const filename of LOCAL_CONTEXT_FILENAMES) {
			const path = join(dir, filename);
			if (!existsSync(path)) continue;
			try {
				files.push({ path, content: readFileSync(path, "utf-8") });
			} catch (error) {
				console.error(
					`[agents-local] failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			break;
		}
	}
	return files;
}

function formatLocalContext(files: LocalContextFile[]): string {
	const sections = files.map(({ path, content }) => `## ${path}\n\n${content.trimEnd()}`);
	return [`# ${SECTION_TITLE}`, "Pi loaded these untracked local-only context files.", ...sections].join("\n\n");
}

function addLocalContextFiles(options: BuildSystemPromptOptions, files: LocalContextFile[]): void {
	const existing = options.contextFiles ?? [];
	const existingPaths = new Set(existing.map((file) => resolve(file.path)));
	const localFiles = files.filter((file) => !existingPaths.has(resolve(file.path)));

	options.contextFiles = [...existing, ...localFiles];
}

function relativeLabel(ctx: ExtensionContext, path: string): string {
	const cwd = resolve(ctx.cwd);
	const full = resolve(path);
	if (full === cwd) return ".";
	if (full.startsWith(`${cwd}/`)) return full.slice(cwd.length + 1);
	return full;
}

export default function agentsLocalExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const files = loadLocalContextFiles(ctx.cwd);
		if (files.length === 0) return;

		addLocalContextFiles(event.systemPromptOptions, files);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${formatLocalContext(files)}`,
		};
	});

	pi.registerCommand("agents-local", {
		description: `Show ${LOCAL_CONTEXT_FILENAMES.join(" / ")} files loaded by the local-context extension`,
		handler: async (_args, ctx) => {
			const files = loadLocalContextFiles(ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify(
					`No ${LOCAL_CONTEXT_FILENAMES.join(" or ")} files found from cwd to filesystem root.`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				files.map((file) => `${relativeLabel(ctx, file.path)} (${file.content.length} chars)`).join("\n"),
				"info",
			);
		},
	});
}
