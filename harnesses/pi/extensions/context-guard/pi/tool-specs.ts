import { z } from "zod";

const LANGUAGE_ENUM = [
	"javascript",
	"typescript",
	"python",
	"shell",
	"ruby",
	"go",
	"rust",
	"php",
	"perl",
	"r",
	"elixir",
	"csharp",
] as const;

export function createPiToolSpecs() {
	return {
		processFile: {
			title: "Execute File Processing",
			description:
				"Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\n" +
				"PREFER THIS OVER Read/cat for: log files, data files, large source files, and any file where you need to extract specific information rather than read the entire content.\n\n" +
				"Write code against FILE_CONTENT and print only the answer.",
			inputSchema: z.object({
				path: z.string().describe("Absolute file path or relative to project root"),
				language: z.enum(LANGUAGE_ENUM).describe("Runtime language"),
				code: z
					.string()
					.describe(
						"Code to process FILE_CONTENT (file_content in Elixir). Print summary via console.log/print/echo/IO.puts/Console.WriteLine.",
					),
				timeout: z.coerce
					.number()
					.optional()
					.describe(
						"Max execution time in ms. When omitted, no internal timer fires and the caller-side timeout governs.",
					),
				intent: z
					.string()
					.optional()
					.describe(
						"What you're looking for in the output. When provided and output is large (>5KB), returns only matching sections via BM25 search instead of truncated output.",
					),
			}),
		},
		index: {
			title: "Index Content",
			description:
				"Index documentation or knowledge content into a searchable BM25 knowledge base. Chunks markdown by headings (keeping code blocks intact) and stores in ephemeral FTS5 database. The full content does NOT stay in context — only a brief summary is returned.\n\n" +
				"After indexing, use cg_search to retrieve specific sections on-demand.",
			inputSchema: z.object({
				content: z.string().optional().describe("Raw text/markdown to index. Provide this OR path, not both."),
				path: z
					.string()
					.optional()
					.describe("File path to read and index (content never enters context). Provide this OR content."),
				source: z
					.string()
					.optional()
					.describe("Label for the indexed content (e.g., 'Context7: React useEffect', 'Skill: frontend-design')"),
			}),
		},
		search: {
			title: "Search Indexed Content",
			description:
				"Search indexed content. Requires prior indexing via exec_command(mode:'batch'), cg_index, or cg_fetch. Pass ALL search questions as queries array in ONE call. File-backed sources are auto-refreshed when the source file changes.\n\nTIPS: 2-4 specific terms per query. Use 'source' to scope results.",
			inputSchema: z.object({
				queries: z.preprocess(
					coerceJsonArray,
					z.array(z.string()).optional().describe("Array of search queries. Batch ALL questions in one call."),
				),
				limit: z.number().optional().default(3).describe("Results per query (default: 3)"),
				source: z.string().optional().describe("Filter to a specific indexed source (partial match)."),
				contentType: z
					.enum(["code", "prose"])
					.optional()
					.describe("Filter results by content type: 'code' or 'prose'."),
				sort: z
					.enum(["relevance", "timeline"])
					.optional()
					.default("relevance")
					.describe(
						"Sort mode. 'relevance' (default): BM25 ranked, current session only. 'timeline': chronological across current session, prior sessions, and auto-memory.",
					),
			}),
		},
		fetch: {
			title: "Fetch & Index URL(s)",
			description:
				"Fetches URL content, converts HTML to markdown, indexes into searchable knowledge base, and returns a preview. Full content stays in sandbox — use cg_search() for deeper lookups.\n\n" +
				"For multi-URL fetches, prefer requests: [{url, source}, ...] with concurrency: 4-8. Single URL uses the legacy url/source shape.",
			inputSchema: z.object({
				url: z.string().optional().describe("Single URL to fetch and index (legacy single-shape)"),
				source: z
					.string()
					.optional()
					.describe(
						"Label for the indexed content when using single `url`. For batch, put source in each requests entry.",
					),
				requests: z
					.array(
						z.object({
							url: z.string().describe("URL to fetch"),
							source: z.string().optional().describe("Label for this URL's indexed content"),
						}),
					)
					.min(1)
					.optional()
					.describe("Batch shape: array of {url, source?} entries."),
				concurrency: z.coerce
					.number()
					.int()
					.min(1)
					.max(8)
					.optional()
					.default(1)
					.describe("Max URLs to fetch in parallel (1-8, default: 1)."),
				force: z.boolean().optional().describe("Skip cache and re-fetch even if content was recently indexed"),
			}),
		},
		status: {
			title: "Context Guard Status",
			description:
				"Returns factual diagnostics for Context Guard: tool calls, indexed bytes, session events, resume snapshots, and continuity sources.",
			inputSchema: z.object({}),
		},
		check: {
			title: "Run Diagnostics",
			description:
				"Diagnose context-guard installation. Runs host-side checks and returns a plain-text status report with [OK]/[FAIL]/[WARN] prefixes (renderer-safe across tool hosts). No CLI execution needed.",
			inputSchema: z.object({}),
		},
		purge: {
			title: "Purge Knowledge Base",
			description:
				"DESTRUCTIVE — permanently delete indexed content. CANNOT be undone.\n\n" +
				"You MUST specify exactly ONE scope:\n\n" +
				'  • { confirm: true, sessionId: "<uuid>" }\n' +
				"      Deletes ONLY that session's events + per-session FTS5 chunks.\n" +
				"      Preserves stats file and ALL other sessions.\n\n" +
				'  • { confirm: true, scope: "project" }\n' +
				"      Wipes the ENTIRE project: FTS5 knowledge base, every session DB row,\n" +
				"      events markdown, AND resets the stats file.\n\n" +
				"REFUSAL / AMBIGUITY RULES:\n" +
				"  • confirm: false -> purge cancelled\n" +
				"  • sessionId + scope:'project' -> ambiguous, reject\n" +
				"  • bare {confirm:true} defaults to project-wide purge for back-compat\n\n" +
				"Use sessionId when the user asks to clear a specific conversation's data. Use scope:'project' ONLY when the user explicitly asks to reset everything. NEVER call with bare {confirm:true}; always specify scope.",
			inputSchema: z.object({
				confirm: z.boolean().describe("MUST be true. Destructive operation; false returns 'purge cancelled'."),
				sessionId: z
					.string()
					.optional()
					.describe("UUID of a single session. MUST NOT be combined with scope:'project'."),
				scope: z
					.enum(["session", "project"])
					.optional()
					.describe("Explicit scope selector. 'session' REQUIRES sessionId. 'project' wipes the entire project."),
			}),
		},
	};
}

function coerceJsonArray(val: unknown): unknown {
	if (typeof val === "string") {
		try {
			const parsed = JSON.parse(val);
			if (Array.isArray(parsed)) return parsed;
		} catch {}
	}
	return val;
}
