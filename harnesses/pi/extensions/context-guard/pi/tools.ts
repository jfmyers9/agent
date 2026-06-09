import { truncateToWidth } from "@earendil-works/pi-tui";
import type { z } from "zod";
import { createHashlineEditAnchor } from "../../fileops/hashline/anchors.js";
import { textComponent } from "../../shared/tui";
import type { PiToolResponse } from "./core.js";
import { buildCoreCheckText, invokeCore } from "./core.js";
import { getPiConfigDir } from "./index.js";
import { getProjectDir, getSessionDbPath, getSessionDir, getStorePath } from "./tool-paths.js";
import { createPiToolSpecs } from "./tool-specs.js";
import { type ToolResult, trackIndexed, trackResponse, VERSION } from "./tool-stats.js";

export { resolveSessionIdFromSessionDB } from "./tool-paths.js";

class ContextToolComponent {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(width: number): string[] {
		return textComponent(this.text)
			.render(width)
			.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}

interface PiRenderTheme {
	bold(text: string): string;
	fg(color: string, text: string): string;
}

type PiRenderContext = Record<string, unknown>;

type DirectToolDef = {
	name: string;
	description: string;
	inputSchema: z.ZodTypeAny;
	handler: (params: any) => Promise<ToolResult>;
};

const DIRECT_TOOLS: DirectToolDef[] = [];
let runtimeInitialized = false;

function displayLabelForTool(toolName: string): string {
	const suffix = toolName.startsWith("cg_") ? toolName.slice(3) : toolName;
	const compact = suffix
		.replace(/^process_file$/, "file")
		.replace(/^run$/, "run")
		.replace(/^batch$/, "batch")
		.replace(/^fetch$/, "fetch")
		.replace(/^search$/, "search")
		.replace(/^index$/, "index")
		.replace(/^status$/, "status")
		.replace(/^check$/, "check")
		.replace(/^purge$/, "purge");
	return compact;
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return toolName;
	const record = args as Record<string, unknown>;
	if (toolName === "cg_search") {
		const query =
			typeof record.query === "string"
				? record.query
				: Array.isArray(record.queries)
					? record.queries.filter((item) => typeof item === "string").join(" | ")
					: "";
		return query ? `cg_search ${JSON.stringify(query)}` : "cg_search";
	}
	if (toolName === "cg_fetch") {
		if (typeof record.url === "string") return `cg_fetch ${record.url}`;
		if (Array.isArray(record.requests)) return `cg_fetch ${record.requests.length} requests`;
	}
	if (toolName === "cg_process_file") {
		return typeof record.path === "string" ? `cg_process_file ${record.path}` : "cg_process_file";
	}
	if (toolName === "cg_index") {
		if (typeof record.path === "string") return `cg_index ${record.path}`;
		if (typeof record.source === "string") return `cg_index ${record.source}`;
	}
	return toolName;
}

function actionTextForTool(toolName: string, args: unknown): string {
	const summary = summarizeToolArgs(toolName, args);
	switch (toolName) {
		case "cg_index":
			return summary === "cg_index"
				? "Context indexed content"
				: `Context indexed ${summary.replace(/^cg_index\s+/, "")}`;
		case "cg_search":
			return summary === "cg_search"
				? "Context searched memory"
				: `Context searched ${summary.replace(/^cg_search\s+/, "")}`;
		case "cg_fetch":
			return summary === "cg_fetch"
				? "Context fetched content"
				: `Context fetched ${summary.replace(/^cg_fetch\s+/, "")}`;
		case "cg_process_file":
			return summary === "cg_process_file"
				? "Context processed file"
				: `Context processed ${summary.replace(/^cg_process_file\s+/, "")}`;
		case "cg_status":
			return "Context status";
		case "cg_check":
			return "Context checked install";
		case "cg_purge":
			return "Context purged memory";
		default:
			return `Context used ${toolName}`;
	}
}

function createDirectCallRenderer(toolName: string) {
	return (_args: unknown, theme: PiRenderTheme, context: PiRenderContext) => {
		return new ContextToolComponent(
			renderContextToolHeader(actionTextForTool(toolName, _args), theme, context?.isPartial === true),
		);
	};
}

function createDirectResultRenderer(toolName: string) {
	return (
		result: PiToolResponse,
		{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
		theme: PiRenderTheme,
		context: PiRenderContext,
	) => {
		if (isPartial) {
			return new ContextToolComponent(
				renderContextToolHeader(actionTextForTool(toolName, context?.args), theme, true),
			);
		}
		const output = (result.content ?? [])
			.filter((c: PiToolResponse["content"][number] | undefined) => c?.type === "text" && typeof c.text === "string")
			.map((c: PiToolResponse["content"][number]) => c.text)
			.join("\n");
		return new ContextToolComponent(renderContextToolOutput(output, theme, expanded));
	};
}

function renderContextToolHeader(command: string, theme: PiRenderTheme, running: boolean): string {
	const marker = running ? theme.fg("dim", "◜") : theme.fg("success", "•");
	return `${marker} ${theme.bold(command)}${running ? theme.fg("dim", " ...") : ""}${theme.fg("dim", " · ")}${theme.fg("mdLink", "\x1b[3mvia context-guard\x1b[23m")}`;
}

function renderContextToolOutput(output: string, theme: PiRenderTheme, expanded: boolean): string {
	const lines = output.replace(/\n$/, "").split(/\r?\n/);
	const visible = expanded ? lines : lines.slice(0, 12);
	const rendered = visible.map((line) => renderMarkdownLine(line, theme)).join("\n");
	const omitted =
		!expanded && lines.length > visible.length
			? `\n${theme.fg("dim", `… +${lines.length - visible.length} lines (ctrl+o transcript)`)}`
			: "";
	return `${rendered}${omitted}`;
}

function renderMarkdownLine(line: string, theme: PiRenderTheme): string {
	const trimmed = line.trimEnd();
	if (trimmed.length === 0) return "";
	const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
	if (heading) {
		const level = heading[1]!.length;
		const text = heading[2]!;
		const marker = theme.fg("dim", `${"#".repeat(level)} `);
		return `${marker}${theme.fg("toolTitle", theme.bold(text))}`;
	}
	const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
	if (bullet) {
		return `${bullet[1] ?? ""}${theme.fg("dim", "- ")}${bullet[2] ?? ""}`;
	}
	const section = /^--- \[(.*)] ---$/.exec(trimmed);
	if (section) {
		return theme.fg("muted", section[1] ?? trimmed);
	}
	return line;
}

function registerDirectTool(
	name: string,
	spec: { description: string; inputSchema: z.ZodTypeAny },
	handler: (params: any) => Promise<ToolResult>,
): void {
	DIRECT_TOOLS.push({ name, description: spec.description, inputSchema: spec.inputSchema, handler });
}

const server = { registerTool: registerDirectTool };

function initDirectToolRuntime(): void {
	if (runtimeInitialized) return;
	runtimeInitialized = true;
	process.on("unhandledRejection", (err) => {
		process.stderr.write(`[context-guard] unhandledRejection: ${err}\n`);
	});
	process.on("uncaughtException", (err) => {
		process.stderr.write(`[context-guard] uncaughtException: ${err?.message ?? err}\n`);
	});
}

const toolSpecs = createPiToolSpecs();

async function withHashlineEditAnchor(result: ToolResult, path: string | undefined): Promise<ToolResult> {
	if (!path) return result;
	try {
		const anchor = await createHashlineEditAnchor(getProjectDir(), path);
		const suffix = [
			"",
			"---",
			"Hashline edit anchor:",
			anchor,
			"Use bounded `read` or `search` when you need source lines in context; use this anchor with discovered line numbers for `edit`.",
		].join("\n");
		return {
			...result,
			content: (result.content ?? []).map((part, index) =>
				index === 0 && part?.type === "text" && typeof part.text === "string"
					? { ...part, text: `${part.text}${suffix}` }
					: part,
			),
		};
	} catch {
		return result;
	}
}

server.registerTool("cg_process_file", toolSpecs.processFile, async ({ path, language, code, timeout, intent }) => {
	const result = await invokeCore("process_file", {
		path,
		language,
		code,
		timeout,
		intent,
		projectDir: getProjectDir(),
	});
	return trackResponse("cg_process_file", await withHashlineEditAnchor(result, path));
});

server.registerTool("cg_index", toolSpecs.index, async ({ content, path, source }) => {
	if (content) trackIndexed(Buffer.byteLength(content));
	const result = await invokeCore("index", {
		dbPath: getStorePath(),
		content,
		path,
		source,
		projectDir: getProjectDir(),
	});
	return trackResponse("cg_index", await withHashlineEditAnchor(result, path));
});

server.registerTool("cg_search", toolSpecs.search, async (params) =>
	trackResponse(
		"cg_search",
		await invokeCore("search", {
			dbPath: getStorePath(),
			...(params as Record<string, unknown>),
			sessionDbPath: getSessionDbPath(),
			projectDir: getProjectDir(),
			configDir: getPiConfigDir(),
		}),
	),
);

server.registerTool("cg_fetch", toolSpecs.fetch, async ({ url, source, requests, concurrency, force }) =>
	trackResponse(
		"cg_fetch",
		await invokeCore("fetch", {
			dbPath: getStorePath(),
			sessionDbPath: getSessionDbPath(),
			url,
			source,
			requests,
			concurrency,
			force,
		}),
	),
);

server.registerTool("cg_status", toolSpecs.status, async () =>
	trackResponse(
		"cg_status",
		await invokeCore("status", {
			dbPath: getStorePath(),
			sessionDbPath: getSessionDbPath(),
			sessionsDir: getSessionDir(),
			configDir: getPiConfigDir(),
			version: VERSION,
			cwd: getProjectDir(),
		}),
	),
);

server.registerTool("cg_check", toolSpecs.check, async () =>
	trackResponse("cg_check", {
		content: [{ type: "text", text: buildCoreCheckText() }],
		isError: false,
	}),
);

server.registerTool("cg_purge", toolSpecs.purge, async ({ confirm, sessionId, scope }) =>
	trackResponse(
		"cg_purge",
		await invokeCore("purge", {
			dbPath: getStorePath(),
			sessionDbPath: getSessionDbPath(),
			confirm,
			scope,
			sessionId,
		}),
	),
);

export function registerPiContextTools(pi: {
	registerTool: (def: {
		name: string;
		label: string;
		description: string;
		parameters: Record<string, unknown>;
		renderShell?: "self";
		renderCall?: (_args: unknown, theme: PiRenderTheme, context: PiRenderContext) => unknown;
		renderResult?: (
			result: PiToolResponse,
			state: { expanded: boolean; isPartial: boolean },
			theme: PiRenderTheme,
			context: PiRenderContext,
		) => unknown;
		execute: (_toolCallId: string, params: unknown) => Promise<PiToolResponse>;
	}) => void;
}): void {
	initDirectToolRuntime();
	for (const def of DIRECT_TOOLS) {
		const label = displayLabelForTool(def.name);
		pi.registerTool({
			name: def.name,
			label: `Context: ${label}`,
			description: def.description,
			parameters: { type: "object", additionalProperties: true, properties: {} },
			renderShell: "self",
			renderCall: createDirectCallRenderer(def.name),
			renderResult: createDirectResultRenderer(def.name),
			async execute(_toolCallId, params) {
				try {
					const parsed = def.inputSchema.parse(params ?? {});
					const result = await def.handler(parsed);
					const text = (result.content ?? [])
						.filter((c) => c?.type === "text" && typeof c.text === "string")
						.map((c) => c.text)
						.join("\n");
					if (result.isError) {
						throw new Error(text || `${def.name} returned an error`);
					}
					return { content: [{ type: "text", text }], details: {} };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(message);
				}
			},
		});
	}
}
