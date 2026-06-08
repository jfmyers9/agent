// @ts-nocheck
/**
 * pretty — Pretty terminal output for pi built-in tools.
 *
 * @module pretty
 * Enhances:
 *   • read       — compact Explore-row rendering for text files
 *   • view_image — image-only file viewer with inline terminal preview
 *   • bash  — colored exit status, stderr highlighting
 *   • ls    — tree-view directory listing with file-type icons
 *
 * Architecture:
 *   1. Wrap SDK factory tools (createReadTool, createBashTool, etc.)
 *   2. Delegate to original execute() — no behavior changes
 *   3. Attach metadata in result.details for custom renderCall/renderResult
 */

import { open as openFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolInput,
	ExtensionContext,
	LsToolInput,
	ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, Image, Spacer } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { configureImageCapabilities } from "../shared/image-capabilities";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

let RST = "\x1b[0m";
const BOLD = "\x1b[1m";

const FG_DIM = "\x1b[38;2;80;80;80m";
const FG_RULE = "\x1b[38;2;50;50;50m";
const FG_GREEN = "\x1b[38;2;100;180;120m";
const FG_RED = "\x1b[38;2;200;100;100m";
const FG_YELLOW = "\x1b[38;2;220;180;80m";
const FG_BLUE = "\x1b[38;2;100;140;220m";

const BG_DEFAULT = "\x1b[49m";
let BG_BASE = BG_DEFAULT; // tool box success/base bg — updated from theme's toolSuccessBg
let BG_ERROR = BG_DEFAULT; // tool box error bg — updated from theme's toolErrorBg

type BgTheme = { getBgAnsi?: (key: string) => string };
type FgTheme = { fg: (key: string, text: string) => string };

/** Parse an ANSI 24-bit color escape into { r, g, b }. Handles both fg (38;2) and bg (48;2). */
function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const m = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

function getThemeBgAnsi(theme: BgTheme, key: string): string | null {
	try {
		const bgAnsi = theme.getBgAnsi?.(key);
		return bgAnsi && parseAnsiRgb(bgAnsi) ? bgAnsi : null;
	} catch {
		return null;
	}
}

/** Read themed tool backgrounds and update BG_BASE / BG_ERROR + RST.
 *  Call once when theme is first available. Idempotent. */
let _bgBaseResolved = false;
function resolveBaseBackground(theme: BgTheme | null | undefined): void {
	if (_bgBaseResolved || !theme?.getBgAnsi) return;
	_bgBaseResolved = true;

	BG_BASE = getThemeBgAnsi(theme, "toolSuccessBg") ?? BG_DEFAULT;
	BG_ERROR = getThemeBgAnsi(theme, "toolErrorBg") ?? BG_BASE;
	RST = `\x1b[0m${BG_BASE}`;
}

function renderToolError(error: string, theme: FgTheme): string {
	return fillToolBackground(`\n${theme.fg("error", error)}`, BG_ERROR);
}

const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strip(s: string): string {
	return s.replace(ANSI_RE, "");
}

function preserveToolBackground(ansi: string, bg: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => {
		const codes = params.split(";");
		return params === "0" || codes.includes("49") ? `${seq}${bg}` : seq;
	});
}

function fillToolBackground(text: string, bg = BG_BASE): string {
	const width = termW();
	return text
		.split("\n")
		.map((line) => {
			const normalized = preserveToolBackground(line, bg);
			const padding = Math.max(0, width - strip(normalized).length);
			return `${bg}${normalized}${" ".repeat(padding)}${RST}`;
		})
		.join("\n");
}

function termW(): number {
	const stderrWithColumns = process.stderr as NodeJS.WriteStream & {
		columns?: number;
	};
	const raw =
		process.stdout.columns || stderrWithColumns.columns || Number.parseInt(process.env.COLUMNS ?? "", 10) || 200;
	return Math.max(80, Math.min(raw - 4, 210));
}

function rule(w: number): string {
	return `${FG_RULE}${"─".repeat(w)}${RST}`;
}

// ---------------------------------------------------------------------------
// File-type icons — Nerd Font glyphs (Seti-UI + Devicons, stable in NF v3+)
//
// Requires a Nerd Font installed (e.g., JetBrainsMono Nerd Font, FiraCode NF).
// Fallback: set PRETTY_ICONS=none to disable icons.
// ---------------------------------------------------------------------------

const ICONS_MODE = (process.env.PRETTY_ICONS ?? "nerd").toLowerCase();
const USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";

// Nerd Font codepoints + ANSI color per file type
const NF_DIR = `${FG_BLUE}\ue5ff${RST}`; // folder
const NF_DEFAULT = `${FG_DIM}\uf15b${RST}`; // generic file

const EXT_ICON: Record<string, string> = {
	// TypeScript / JavaScript
	ts: `\x1b[38;2;49;120;198m\ue628${RST}`, // blue
	tsx: `\x1b[38;2;49;120;198m\ue7ba${RST}`, // react blue
	js: `\x1b[38;2;241;224;90m\ue74e${RST}`, // yellow
	jsx: `\x1b[38;2;97;218;251m\ue7ba${RST}`, // react cyan
	mjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	cjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,

	// Systems / Backend
	py: `\x1b[38;2;55;118;171m\ue73c${RST}`, // python blue
	rs: `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust orange
	go: `\x1b[38;2;0;173;216m\ue724${RST}`, // go cyan
	java: `\x1b[38;2;204;62;68m\ue738${RST}`, // java red
	swift: `\x1b[38;2;255;172;77m\ue755${RST}`, // swift orange
	rb: `\x1b[38;2;204;52;45m\ue739${RST}`, // ruby red
	kt: `\x1b[38;2;126;103;200m\ue634${RST}`, // kotlin purple
	c: `\x1b[38;2;85;154;211m\ue61e${RST}`, // c blue
	cpp: `\x1b[38;2;85;154;211m\ue61d${RST}`, // cpp blue
	h: `\x1b[38;2;140;160;185m\ue61e${RST}`, // header muted
	hpp: `\x1b[38;2;140;160;185m\ue61d${RST}`,
	cs: `\x1b[38;2;104;33;122m\ue648${RST}`, // c# purple

	// Web
	html: `\x1b[38;2;228;77;38m\ue736${RST}`, // html orange
	css: `\x1b[38;2;66;165;245m\ue749${RST}`, // css blue
	scss: `\x1b[38;2;207;100;154m\ue749${RST}`, // scss pink
	less: `\x1b[38;2;66;165;245m\ue749${RST}`,
	vue: `\x1b[38;2;65;184;131m\ue6a0${RST}`, // vue green
	svelte: `\x1b[38;2;255;62;0m\ue697${RST}`, // svelte red-orange

	// Config / Data
	json: `\x1b[38;2;241;224;90m\ue60b${RST}`, // json yellow
	jsonc: `\x1b[38;2;241;224;90m\ue60b${RST}`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8${RST}`, // yaml purple
	yml: `\x1b[38;2;160;116;196m\ue6a8${RST}`,
	toml: `\x1b[38;2;160;116;196m\ue6b2${RST}`, // toml purple
	xml: `\x1b[38;2;228;77;38m\ue619${RST}`, // xml orange
	sql: `\x1b[38;2;218;218;218m\ue706${RST}`, // sql gray

	// Markdown / Docs
	md: `\x1b[38;2;66;165;245m\ue73e${RST}`, // markdown blue
	mdx: `\x1b[38;2;66;165;245m\ue73e${RST}`,

	// Shell / Scripts
	sh: `\x1b[38;2;137;180;130m\ue795${RST}`, // shell green
	bash: `\x1b[38;2;137;180;130m\ue795${RST}`,
	zsh: `\x1b[38;2;137;180;130m\ue795${RST}`,
	fish: `\x1b[38;2;137;180;130m\ue795${RST}`,
	lua: `\x1b[38;2;81;160;207m\ue620${RST}`, // lua blue
	php: `\x1b[38;2;137;147;186m\ue73d${RST}`, // php purple
	dart: `\x1b[38;2;87;182;240m\ue798${RST}`, // dart blue

	// Images
	png: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpeg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	gif: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	svg: `\x1b[38;2;255;180;50m\uf1c5${RST}`,
	webp: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	ico: `\x1b[38;2;160;116;196m\uf1c5${RST}`,

	// Misc
	lock: `\x1b[38;2;130;130;130m\uf023${RST}`, // lock gray
	env: `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	graphql: `\x1b[38;2;224;51;144m\ue662${RST}`, // graphql pink
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`,
};

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e${RST}`, // npm green
	"package-lock.json": `\x1b[38;2;130;130;130m\ue71e${RST}`, // npm gray
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628${RST}`, // ts blue
	"biome.json": `\x1b[38;2;96;165;250m\ue615${RST}`, // config blue
	".gitignore": `\x1b[38;2;222;165;132m\ue702${RST}`, // git orange
	".git": `\x1b[38;2;222;165;132m\ue702${RST}`,
	".env": `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	".envrc": `\x1b[38;2;241;224;90m\ue615${RST}`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`, // docker blue
	makefile: `\x1b[38;2;130;130;130m\ue615${RST}`, // make gray
	gnumakefile: `\x1b[38;2;130;130;130m\ue615${RST}`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e${RST}`, // readme blue
	license: `\x1b[38;2;218;218;218m\ue60a${RST}`, // license white
	"cargo.toml": `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust
	"go.mod": `\x1b[38;2;0;173;216m\ue724${RST}`, // go
	"pyproject.toml": `\x1b[38;2;55;118;171m\ue73c${RST}`, // python
};

function fileIcon(fp: string): string {
	if (!USE_ICONS) return "";
	const base = basename(fp).toLowerCase();
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
	const ext = extname(fp).slice(1).toLowerCase();
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

function dirIcon(): string {
	return USE_ICONS ? `${NF_DIR} ` : "";
}

function sp(path: string): string {
	return path || ".";
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Render bash output with colored exit code and stderr highlighting. */
function renderBashOutput(text: string, exitCode: number | null): { summary: string; body: string } {
	const isOk = exitCode === 0;
	const statusFg = isOk ? FG_GREEN : FG_RED;
	const statusIcon = isOk ? "✓" : "✗";
	const codeStr = exitCode !== null ? `${statusFg}${statusIcon} exit ${exitCode}${RST}` : `${FG_YELLOW}⚡ killed${RST}`;

	const lines = text.split("\n");
	const maxShow = MAX_PREVIEW_LINES;
	const show = lines.slice(0, maxShow);
	const remaining = lines.length - maxShow;

	let body = show.join("\n");
	if (remaining > 0) {
		body += `\n${FG_DIM}  … ${remaining} more lines${RST}`;
	}

	return { summary: codeStr, body };
}

/** Render ls output as a tree view with icons. */
function renderTree(text: string, _basePath: string): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(empty directory)${RST}`;

	const out: string[] = [];
	const total = lines.length;
	const show = lines.slice(0, MAX_PREVIEW_LINES);

	for (let i = 0; i < show.length; i++) {
		const entry = show[i].trim();
		const isLast = i === show.length - 1 && total <= MAX_PREVIEW_LINES;
		const prefix = isLast ? "└── " : "├── ";
		const connector = `${FG_RULE}${prefix}${RST}`;

		// Detect directories (entries ending with /)
		const isDir = entry.endsWith("/");
		const name = isDir ? entry.slice(0, -1) : entry;
		const icon = isDir ? dirIcon() : fileIcon(name);
		const fg = isDir ? FG_BLUE + BOLD : "";
		const reset = isDir ? RST : "";

		out.push(`${connector}${icon}${fg}${name}${reset}`);
	}

	if (total > MAX_PREVIEW_LINES) {
		out.push(`${FG_RULE}└── ${RST}${FG_DIM}… ${total - MAX_PREVIEW_LINES} more entries${RST}`);
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Tool/rendering support
// ---------------------------------------------------------------------------

type ToolTextContent = TextContent;
type ToolContent = TextContent | ImageContent;
type ToolResultLike<TDetails = unknown> = AgentToolResult<TDetails | undefined>;
type TextComponentLike = {
	setText(value: string): void;
	getText?: () => string;
};
type ComponentLike = TextComponentLike | Container;
type TextComponentCtor = new (text?: string, x?: number, y?: number) => TextComponentLike;
type ThemeLike = BgTheme & FgTheme & { bold: (text: string) => string };
type RenderContextLike<TState extends Record<string, string | undefined> = Record<string, string | undefined>> = {
	args?: unknown;
	lastComponent?: ComponentLike;
	state: TState;
	expanded: boolean;
	showImages?: boolean;
	isError: boolean;
	isPartial?: boolean;
	toolCallId?: string;
	invalidate: () => void;
};
type ToolExecutor<TParams, TDetails = unknown> = (
	toolCallId: string,
	params: TParams,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails | undefined>,
	ctx?: ExtensionContext,
) => Promise<ToolResultLike<TDetails>>;
type ToolDefinitionLike<TParams, TDetails = unknown> = {
	name?: string;
	description?: string;
	label?: string;
	promptSnippet?: string;
	parameters?: unknown;
	execute: ToolExecutor<TParams, TDetails>;
	renderCall?: (args: TParams, theme: ThemeLike, ctx: RenderContextLike) => ComponentLike;
	renderResult?: (
		result: ToolResultLike<TDetails>,
		options: unknown,
		theme: ThemeLike,
		ctx: RenderContextLike,
	) => ComponentLike;
};
type ToolFactory<TParams, TDetails = unknown> = (
	cwd: string,
	options?: unknown,
) => ToolDefinitionLike<TParams, TDetails>;
type PiPrettySdk = {
	createReadToolDefinition?: ToolFactory<ReadToolInput>;
	createReadTool?: ToolFactory<ReadToolInput>;
	createBashToolDefinition?: ToolFactory<BashToolInput>;
	createBashTool?: ToolFactory<BashToolInput>;
	createLsToolDefinition?: ToolFactory<LsToolInput>;
	createLsTool?: ToolFactory<LsToolInput>;
};
type PiPrettyApi = {
	registerTool: (tool: unknown) => void;
	on?: (event: string, handler: (event: any) => void) => void;
};
type ViewImageParams = { path: string };
type BashParams = BashToolInput;
type LsParams = LsToolInput;
type RenderDetails =
	| {
			_type: "bashResult";
			text: string;
			exitCode: number | null;
			command: string;
	  }
	| { _type: "lsResult"; text: string; path: string; entryCount: number };

function isTextContent(content: ToolContent): content is ToolTextContent {
	return content.type === "text";
}

function isImageContent(content: ToolContent): content is ImageContent {
	return content.type === "image";
}

function getTextContent(result: ToolResultLike): string {
	return (
		result.content
			?.filter(isTextContent)
			.map((content) => content.text || "")
			.join("\n") ?? ""
	);
}

function setResultDetails<T>(result: ToolResultLike, details: T): void {
	result.details = details;
}

function readDisplayPath(cwd: string, filePath: string | undefined): string {
	if (!filePath) return "file";
	const absolute = resolve(cwd, filePath);
	const rel = relative(cwd, absolute);
	const withinCwd = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));

	if (!isAbsolute(filePath) || withinCwd) return rel || ".";
	return absolute;
}

function viewImageDisplayPath(cwd: string, args: { path?: string }) {
	return readDisplayPath(cwd, args.path);
}

async function detectSupportedImageMimeType(filePath: string): Promise<string | null> {
	const handle = await openFile(filePath, "r");
	try {
		const buffer = Buffer.alloc(12);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (
			bytesRead >= 8 &&
			buffer[0] === 0x89 &&
			buffer[1] === 0x50 &&
			buffer[2] === 0x4e &&
			buffer[3] === 0x47 &&
			buffer[4] === 0x0d &&
			buffer[5] === 0x0a &&
			buffer[6] === 0x1a &&
			buffer[7] === 0x0a
		) {
			return "image/png";
		}
		if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
			return "image/jpeg";
		}
		if (
			bytesRead >= 6 &&
			buffer[0] === 0x47 &&
			buffer[1] === 0x49 &&
			buffer[2] === 0x46 &&
			buffer[3] === 0x38 &&
			(buffer[4] === 0x37 || buffer[4] === 0x39) &&
			buffer[5] === 0x61
		) {
			return "image/gif";
		}
		if (
			bytesRead >= 12 &&
			buffer[0] === 0x52 &&
			buffer[1] === 0x49 &&
			buffer[2] === 0x46 &&
			buffer[3] === 0x46 &&
			buffer[8] === 0x57 &&
			buffer[9] === 0x45 &&
			buffer[10] === 0x42 &&
			buffer[11] === 0x50
		) {
			return "image/webp";
		}
		return null;
	} finally {
		await handle.close();
	}
}

async function imageMimeTypeForExistingPath(filePath: string): Promise<string | null> {
	return detectSupportedImageMimeType(filePath);
}

async function convertImageForKittyPreview(content: ImageContent): Promise<ImageContent> {
	if (getCapabilities().images !== "kitty" || content.mimeType === "image/png" || !content.data || !content.mimeType) {
		return content;
	}

	try {
		const packageEntry = require.resolve("@earendil-works/pi-coding-agent");
		const converterUrl = pathToFileURL(resolve(dirname(packageEntry), "utils/image-convert.js")).href;
		const { convertToPng } = (await import(converterUrl)) as {
			convertToPng?: (data: string, mimeType: string) => Promise<{ data: string; mimeType: string } | null>;
		};
		const converted = await convertToPng?.(content.data, content.mimeType);
		return converted ? { ...content, data: converted.data, mimeType: converted.mimeType } : content;
	} catch {
		return content;
	}
}

async function convertResultImagesForKittyPreview(result: ToolResultLike): Promise<ToolResultLike> {
	if (getCapabilities().images !== "kitty") return result;

	let changed = false;
	const content = await Promise.all(
		(result.content ?? []).map(async (item) => {
			if (!isImageContent(item)) return item;
			const converted = await convertImageForKittyPreview(item);
			if (converted !== item) changed = true;
			return converted;
		}),
	);

	return changed ? { ...result, content } : result;
}

function createTextComponent(
	TextComponent: TextComponentCtor,
	ctx: RenderContextLike,
	initialText = "",
): TextComponentLike {
	return "setText" in (ctx.lastComponent ?? {})
		? (ctx.lastComponent as TextComponentLike)
		: new TextComponent(initialText, 0, 0);
}

function renderViewImageResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContextLike,
	TextComponent: TextComponentCtor,
): ComponentLike {
	if (ctx.isError) {
		const text = createTextComponent(TextComponent, ctx);
		text.setText(theme.fg("error", getTextContent(result) || "Error"));
		return text;
	}

	const imageBlocks = result.content?.filter(isImageContent) ?? [];
	const supportsImages = Boolean(getCapabilities().images);
	if (!supportsImages || imageBlocks.length === 0) {
		const text = createTextComponent(TextComponent, ctx);
		text.setText(getTextContent(result));
		return text;
	}

	if (ctx.showImages) {
		const text = createTextComponent(TextComponent, ctx);
		text.setText("");
		return text;
	}

	const container = new Container();
	let hasContent = false;
	for (const image of imageBlocks) {
		if (!image.data || !image.mimeType) continue;
		if (hasContent) container.addChild(new Spacer(1));
		container.addChild(
			new Image(
				image.data,
				image.mimeType,
				{ fallbackColor: (text) => theme.fg("toolOutput", text) },
				{ maxWidthCells: Number.MAX_SAFE_INTEGER },
			),
		);
		hasContent = true;
	}
	return container;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Dependencies that can be injected for testing.
 * In production, omit `deps` — the extension uses require() to load them.
 */
export interface PiPrettyDeps {
	sdk: PiPrettySdk;
	TextComponent: TextComponentCtor;
}

export default function piPrettyExtension(pi: PiPrettyApi, deps?: PiPrettyDeps): void {
	configureImageCapabilities();

	let createReadTool: ToolFactory<ReadToolInput> | undefined;
	let createBashTool: ToolFactory<BashToolInput> | undefined;
	let createLsTool: ToolFactory<LsToolInput> | undefined;
	let TextComponent: TextComponentCtor;

	let sdk: PiPrettySdk;

	if (deps) {
		// Test path: use injected dependencies, reset module state
		sdk = deps.sdk;
		createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
		createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
		createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
		TextComponent = deps.TextComponent;
	} else {
		try {
			sdk = require("@earendil-works/pi-coding-agent");
			createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
			createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
			createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
			TextComponent = require("@earendil-works/pi-tui").Text;
		} catch {
			return;
		}
	}
	if (!createReadTool || !TextComponent) return;

	const cwd = process.cwd();
	const viewImageParameters = Type.Object({
		path: Type.String({
			description: "Path to the image file to view (relative or absolute)",
		}),
	});

	const origImageRead = createReadTool(cwd);

	// ===================================================================
	// view_image — image-only read with forced inline preview
	// ===================================================================

	pi.registerTool({
		...origImageRead,
		name: "view_image",
		label: "view_image",
		description: "Read/view a local image from the filesystem",
		promptSnippet: "View image file",
		parameters: viewImageParameters,
		renderShell: "self",

		async execute(
			tid: string,
			params: ViewImageParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		) {
			const mimeType = await imageMimeTypeForExistingPath(resolve(cwd, params.path));
			if (!mimeType) {
				throw new Error(`view_image only supports jpg, png, gif, and webp image files. Use read for ${params.path}.`);
			}
			const result = (await origImageRead.execute(tid, { path: params.path }, sig, upd, ctx)) as ToolResultLike;
			return convertResultImagesForKittyPreview(result);
		},

		renderCall(args: ViewImageParams, theme: ThemeLike, ctx: RenderContextLike) {
			const text = createTextComponent(TextComponent, ctx);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("Viewed image"))} ${theme.fg("dim", "─")} ${theme.fg("dim", viewImageDisplayPath(cwd, args))}`,
			);
			return text;
		},

		renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
			return renderViewImageResult(result, theme, ctx, TextComponent);
		},
	});

	// ===================================================================
	// bash — colored exit status
	// ===================================================================

	if (createBashTool) {
		const origBash = createBashTool(cwd);

		pi.registerTool({
			...origBash,
			name: "bash",

			async execute(
				tid: string,
				params: BashParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origBash.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);

				let exitCode: number | null = 0;
				if (textContent) {
					const exitMatch = textContent.match(/(?:exit code|exited with|exit status)[:\s]*(\d+)/i);
					if (exitMatch) exitCode = Number(exitMatch[1]);
					if (textContent.includes("command not found") || textContent.includes("No such file")) {
						exitCode = 1;
					}
				}

				setResultDetails(result, {
					_type: "bashResult",
					text: textContent ?? "",
					exitCode,
					command: params.command ?? "",
				});

				return result;
			},

			renderCall(args: BashParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const cmd = args.command ?? "";
				const text = createTextComponent(TextComponent, ctx);
				const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";
				text.setText(
					fillToolBackground(
						`${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd)}${timeout}`,
					),
				);
				return text;
			},

			renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const text = createTextComponent(TextComponent, ctx);

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
					return text;
				}

				const d = result.details as RenderDetails | undefined;
				if (d?._type === "bashResult") {
					const { summary } = renderBashOutput(d.text, d.exitCode);
					const lines = d.text.split("\n");
					const lineCount = lines.length;
					const lineInfo = lineCount > 1 ? `  ${FG_DIM}(${lineCount} lines)${RST}` : "";
					const header = `  ${summary}${lineInfo}`;

					if (d.text.trim()) {
						const maxShow = ctx.expanded ? lineCount : MAX_PREVIEW_LINES;
						const show = lines.slice(0, maxShow);
						const tw = termW();
						const out: string[] = [header, rule(tw)];
						for (const line of show) {
							out.push(`  ${line}`);
						}
						out.push(rule(tw));
						if (lineCount > maxShow) {
							out.push(`${FG_DIM}  … ${lineCount - maxShow} more lines${RST}`);
						}
						text.setText(fillToolBackground(out.join("\n")));
					} else {
						text.setText(fillToolBackground(header));
					}
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "done";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
				return text;
			},
		});
	}

	// ===================================================================
	// ls — tree view with icons
	// ===================================================================

	if (createLsTool) {
		const origLs = createLsTool(cwd);

		pi.registerTool({
			...origLs,
			name: "ls",

			async execute(
				tid: string,
				params: LsParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origLs.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);
				const fp = params.path ?? cwd;
				const entryCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails(result, {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount,
				});

				return result;
			},

			renderCall(args: LsParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const fp = args.path ?? ".";
				const text = createTextComponent(TextComponent, ctx);
				text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", sp(fp))}`));
				return text;
			},

			renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const text = createTextComponent(TextComponent, ctx);

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
					return text;
				}

				const d = result.details as RenderDetails | undefined;
				if (d?._type === "lsResult" && d.text) {
					const tree = renderTree(d.text, d.path);
					const info = `${FG_DIM}${d.entryCount} entries${RST}`;
					text.setText(fillToolBackground(`  ${info}\n${tree}`));
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "listed";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
				return text;
			},
		});
	}
}
