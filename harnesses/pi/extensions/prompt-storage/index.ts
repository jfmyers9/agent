// @ts-nocheck
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
	CustomEditor,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type EditorComponent,
	type EditorTheme,
	type Focusable,
	fuzzyMatch,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

type PromptKind = "stash" | "history";
type PickerAction = "apply" | "pop" | "drop";
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
type EditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => EditorComponent;

type EditorUi = {
	getEditorComponent?: () => EditorFactory | undefined;
	setEditorComponent: (factory: EditorFactory | undefined) => void;
};

interface Config {
	enabled: boolean;
	shortcuts: {
		stash: string;
		pop: string;
		history: string;
	};
	history: {
		includeSlashCommands: boolean;
		maxResults: number;
	};
	picker: {
		maxVisible: number;
		enterAction: "apply" | "pop";
	};
}

interface PromptItem {
	kind: PromptKind;
	id: number | string;
	text: string;
	timestamp: number;
	cwd: string;
	sessionPath?: string;
	sessionName?: string;
	hasImages?: boolean;
	searchText: string;
}

interface PickerResult {
	item: PromptItem;
	action: PickerAction;
}

interface IndexProgress {
	phase: "sessions" | "prompts";
	loaded: number;
	total: number;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(extensionDir, "config.json");
const dbPath = join(
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
	"pi",
	"prompt-storage.sqlite",
);

const defaultConfig: Config = {
	enabled: true,
	shortcuts: {
		stash: "alt+s",
		pop: "ctrl+alt+s",
		history: "ctrl+r",
	},
	history: {
		includeSlashCommands: false,
		maxResults: 120,
	},
	picker: {
		maxVisible: 10,
		enterAction: "apply",
	},
};

const stashHudWidgetId = "prompt-storage-stash";
let db: DatabaseSync | undefined;
const historyRefreshes = new Map<string, Promise<void>>();
const wrappedFactory = Symbol.for("prompt-storage.editorFactoryWrapped");
let stashHud: StashHudWidget | undefined;
let stashHudLines: string[] = [];
let restackTimer: ReturnType<typeof setTimeout> | undefined;

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(
			readFileSync(configPath, "utf8"),
		) as Partial<Config>;
		return {
			...defaultConfig,
			...parsed,
			shortcuts: { ...defaultConfig.shortcuts, ...parsed.shortcuts },
			history: { ...defaultConfig.history, ...parsed.history },
			picker: { ...defaultConfig.picker, ...parsed.picker },
		};
	} catch {
		return defaultConfig;
	}
}

async function openDb(): Promise<DatabaseSync> {
	if (db) return db;
	await mkdir(dirname(dbPath), { recursive: true });
	db = new DatabaseSync(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS stashes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			text TEXT NOT NULL,
			cwd TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS session_index (
			session_path TEXT PRIMARY KEY,
			modified_ms INTEGER NOT NULL,
			indexed_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS history_prompts (
			session_path TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			text TEXT NOT NULL,
			cwd TEXT NOT NULL,
			session_name TEXT,
			prompt_ts INTEGER NOT NULL,
			has_images INTEGER NOT NULL DEFAULT 0,
			search_text TEXT NOT NULL,
			PRIMARY KEY (session_path, entry_id)
		);
		CREATE INDEX IF NOT EXISTS idx_stashes_created_at ON stashes(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_history_prompt_ts ON history_prompts(prompt_ts DESC);
	`);
	return db;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type?: unknown; text?: unknown } =>
				!!block && typeof block === "object",
		)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text).trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

function hasImages(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.some(
			(block) =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "image",
		)
	);
}

function timestampMs(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = new Date(value).getTime();
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function preview(value: string, max = 90): string {
	const compact = compactWhitespace(value);
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function isSlashCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
}

function buildSearchText(
	text: string,
	cwd: string,
	sessionName?: string,
): string {
	return `${text}\n${cwd}\n${sessionName ?? ""}`.toLowerCase();
}

function dateLabel(timestamp: number): string {
	return new Date(timestamp).toLocaleString("en-GB", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sourceLabel(item: PromptItem): string {
	if (item.kind === "stash") return preview(item.text, 48);
	if (item.sessionName?.trim()) return item.sessionName.trim();
	if (item.sessionPath)
		return item.sessionPath.split(/[\\/]/).pop() ?? "session";
	return "session";
}

class StashHudWidget implements Component {
	private lines: string[] = [];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {
		this.lines = stashHudLines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
		stashHudLines = lines;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.lines.map((line) =>
			truncateToWidth(this.dim(line), width),
		);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private dim(line: string): string {
		return this.theme.fg("dim", line);
	}
}

function makeItemSearchText(item: Omit<PromptItem, "searchText">): string {
	return buildSearchText(item.text, item.cwd, item.sessionName);
}

function rowString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : "";
}

function rowNumber(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	return typeof value === "number" ? value : Number(value);
}

async function insertStash(text: string, cwd: string): Promise<number> {
	const database = await openDb();
	const result = database
		.prepare("INSERT INTO stashes (text, cwd, created_at) VALUES (?, ?, ?)")
		.run(text, cwd, Date.now());
	return Number(result.lastInsertRowid);
}

async function deleteStash(id: number): Promise<void> {
	const database = await openDb();
	database.prepare("DELETE FROM stashes WHERE id = ?").run(id);
}

async function listStashes(cwd?: string): Promise<PromptItem[]> {
	const database = await openDb();
	const statement =
		cwd === undefined
			? database.prepare(
					"SELECT id, text, cwd, created_at FROM stashes ORDER BY created_at DESC",
				)
			: database.prepare(
					"SELECT id, text, cwd, created_at FROM stashes WHERE cwd = ? ORDER BY created_at DESC",
				);
	return statement.all(...(cwd === undefined ? [] : [cwd])).map((row) => {
		const record = row as Record<string, unknown>;
		const item: Omit<PromptItem, "searchText"> = {
			kind: "stash",
			id: rowNumber(record, "id"),
			text: rowString(record, "text"),
			cwd: rowString(record, "cwd"),
			timestamp: rowNumber(record, "created_at"),
		};
		return { ...item, searchText: makeItemSearchText(item) };
	});
}

async function updateStashHud(ctx: ExtensionContext): Promise<void> {
	const stashes = await listStashes(ctx.cwd);
	if (stashes.length === 0) {
		clearStashHud(ctx);
		return;
	}
	const lines = [
		`Prompt stash (${stashes.length})`,
		...stashes.map((stash) => {
			const cwd = relative(homedir(), stash.cwd) || stash.cwd;
			return `• ${preview(stash.text, 96)}  ${dateLabel(stash.timestamp)}  ${cwd}`;
		}),
	];
	setStashHudLines(lines);
	if (!stashHud) installStashHud(ctx);
}

function setStashHudLines(lines: string[]): void {
	stashHudLines = lines;
	stashHud?.setLines(lines);
}

function clearStashHud(ctx: ExtensionContext): void {
	stashHudLines = [];
	if (!stashHud) return;
	stashHud = undefined;
	ctx.ui.setWidget(stashHudWidgetId, undefined);
}

function currentSessionPrompts(
	ctx: ExtensionContext,
	config: Config,
): PromptItem[] {
	const sessionPath = ctx.sessionManager.getSessionFile();
	if (!sessionPath) return [];
	const sessionName = ctx.sessionManager.getSessionName();
	const records: PromptItem[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			content?: unknown;
			timestamp?: unknown;
		};
		if (message.role !== "user") continue;
		const text = extractText(message.content);
		if (!text) continue;
		if (!config.history.includeSlashCommands && isSlashCommand(text)) continue;
		const item: Omit<PromptItem, "searchText"> = {
			kind: "history",
			id: entry.id,
			text,
			cwd: ctx.cwd,
			timestamp: timestampMs(
				message.timestamp,
				timestampMs(entry.timestamp, Date.now()),
			),
			sessionPath,
			sessionName,
			hasImages: hasImages(message.content),
		};
		records.push({ ...item, searchText: makeItemSearchText(item) });
	}
	return records;
}

async function refreshProjectHistoryIndex(
	cwd: string,
	config: Config,
	onProgress?: (progress: IndexProgress) => void,
): Promise<void> {
	const database = await openDb();
	const sessions = await SessionManager.list(cwd, undefined, (loaded, total) =>
		onProgress?.({ phase: "sessions", loaded, total }),
	);
	let loaded = 0;
	for (const session of sessions) {
		const modifiedMs = session.modified.getTime();
		const indexed = database
			.prepare("SELECT modified_ms FROM session_index WHERE session_path = ?")
			.get(session.path) as Record<string, unknown> | undefined;
		if (indexed && rowNumber(indexed, "modified_ms") === modifiedMs) {
			loaded++;
			onProgress?.({ phase: "prompts", loaded, total: sessions.length });
			continue;
		}
		try {
			const manager = SessionManager.open(session.path);
			database.exec("BEGIN");
			database
				.prepare("DELETE FROM history_prompts WHERE session_path = ?")
				.run(session.path);
			const insert = database.prepare(
				"INSERT OR REPLACE INTO history_prompts (session_path, entry_id, text, cwd, session_name, prompt_ts, has_images, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const entry of manager.getEntries()) {
				if (entry.type !== "message") continue;
				const message = entry.message as {
					role?: string;
					content?: unknown;
					timestamp?: unknown;
				};
				if (message.role !== "user") continue;
				const text = extractText(message.content);
				if (!text) continue;
				if (!config.history.includeSlashCommands && isSlashCommand(text))
					continue;
				insert.run(
					session.path,
					entry.id,
					text,
					session.cwd,
					session.name ?? null,
					timestampMs(
						message.timestamp,
						timestampMs(entry.timestamp, modifiedMs),
					),
					hasImages(message.content) ? 1 : 0,
					buildSearchText(text, session.cwd, session.name),
				);
			}
			database
				.prepare(
					"INSERT OR REPLACE INTO session_index (session_path, modified_ms, indexed_at) VALUES (?, ?, ?)",
				)
				.run(session.path, modifiedMs, Date.now());
			database.exec("COMMIT");
		} catch {
			try {
				database.exec("ROLLBACK");
			} catch {}
		}
		loaded++;
		onProgress?.({ phase: "prompts", loaded, total: sessions.length });
	}
}

function refreshProjectHistorySoon(cwd: string, config: Config): void {
	if (historyRefreshes.has(cwd)) return;
	const refresh = refreshProjectHistoryIndex(cwd, config)
		.catch(() => {})
		.finally(() => {
			historyRefreshes.delete(cwd);
		});
	historyRefreshes.set(cwd, refresh);
}

async function listHistory(
	ctx: ExtensionContext,
	config: Config,
): Promise<PromptItem[]> {
	const database = await openDb();
	const indexed: PromptItem[] = database
		.prepare(
			"SELECT session_path, entry_id, text, cwd, session_name, prompt_ts, has_images, search_text FROM history_prompts WHERE cwd = ? ORDER BY prompt_ts DESC LIMIT ?",
		)
		.all(ctx.cwd, config.history.maxResults * 8)
		.map((row): PromptItem => {
			const record = row as Record<string, unknown>;
			return {
				kind: "history" as const,
				id: rowString(record, "entry_id"),
				text: rowString(record, "text"),
				cwd: rowString(record, "cwd"),
				timestamp: rowNumber(record, "prompt_ts"),
				sessionPath: rowString(record, "session_path"),
				sessionName: rowString(record, "session_name") || undefined,
				hasImages: rowNumber(record, "has_images") === 1,
				searchText: rowString(record, "search_text"),
			};
		});
	const merged = new Map<string, PromptItem>();
	for (const item of indexed.concat(currentSessionPrompts(ctx, config))) {
		const key = `${item.sessionPath ?? ""}|${item.id}|${item.text}`;
		merged.set(key, item);
	}
	return [...merged.values()]
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, config.history.maxResults);
}

function filterItems(
	items: PromptItem[],
	query: string,
	limit: number,
): PromptItem[] {
	const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return items.slice(0, limit);
	return items
		.filter((item) =>
			tokens.every((token) => fuzzyMatch(token, item.searchText).matches),
		)
		.slice(0, limit);
}

class PromptPicker extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly list = new Container();
	private filtered: PromptItem[] = [];
	private selected = 0;
	private focusedValue = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		title: string,
		private readonly items: PromptItem[],
		private readonly config: Config,
		private readonly mode: PromptKind,
		private readonly done: (result: PickerResult | null) => void,
	) {
		super();
		this.searchInput.onSubmit = () =>
			this.choose(this.mode === "stash" ? "pop" : "apply");
		this.searchInput.onEscape = () => this.done(null);
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", theme.bold(` ${title} `)), 0, 0));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					"Type to fuzzy-filter prompt text, cwd, or session name",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.helpText(), 0, 0));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.applyFilter();
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.searchInput.focused = value;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.up) ||
			matchesKey(data, Key.ctrl("p")) ||
			data === "\u0010"
		) {
			this.move(-1);
		} else if (
			matchesKey(data, Key.down) ||
			matchesKey(data, Key.ctrl("n")) ||
			data === "\u000e"
		) {
			this.move(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.move(-this.config.picker.maxVisible);
		} else if (matchesKey(data, Key.pageDown)) {
			this.move(this.config.picker.maxVisible);
		} else if (matchesKey(data, Key.enter)) {
			this.choose(this.mode === "stash" ? "pop" : "apply");
		} else if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c"))
		) {
			this.done(null);
		} else if (this.mode === "stash" && matchesKey(data, Key.ctrl("a"))) {
			this.choose("apply");
		} else if (this.mode === "stash" && matchesKey(data, Key.ctrl("x"))) {
			this.choose("drop");
		} else {
			this.searchInput.handleInput(data);
			this.selected = 0;
			this.applyFilter();
		}
		this.tui.requestRender();
	}

	private helpText(): string {
		const stashHelp =
			"enter pop • ctrl+a apply • ctrl+x drop • ↑↓/ctrl+n/ctrl+p move • esc cancel";
		const historyHelp = "enter apply • ↑↓ move • esc cancel";
		return this.theme.fg(
			"dim",
			this.mode === "stash" ? stashHelp : historyHelp,
		);
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selected = Math.max(
			0,
			Math.min(this.filtered.length - 1, this.selected + delta),
		);
		this.rebuildList();
	}

	private choose(action: PickerAction): void {
		const item = this.filtered[this.selected];
		if (item) this.done({ item, action });
	}

	private applyFilter(): void {
		this.filtered = filterItems(
			this.items,
			this.searchInput.getValue(),
			this.config.history.maxResults,
		);
		this.selected = Math.min(
			this.selected,
			Math.max(0, this.filtered.length - 1),
		);
		this.rebuildList();
	}

	private rebuildList(): void {
		this.list.clear();
		if (this.filtered.length === 0) {
			this.list.addChild(
				new Text(this.theme.fg("warning", "No matching prompts"), 0, 0),
			);
			return;
		}
		const visible = this.config.picker.maxVisible;
		const start = Math.max(
			0,
			Math.min(
				this.selected - Math.floor(visible / 2),
				this.filtered.length - visible,
			),
		);
		for (
			let index = start;
			index < Math.min(start + visible, this.filtered.length);
			index++
		) {
			this.list.addChild(
				new Text(this.formatLine(this.filtered[index]!, index), 0, 0),
			);
		}
		if (start > 0 || start + visible < this.filtered.length) {
			this.list.addChild(
				new Text(
					this.theme.fg(
						"muted",
						`(${this.selected + 1}/${this.filtered.length})`,
					),
					0,
					0,
				),
			);
		}
	}

	private formatLine(item: PromptItem, index: number): string {
		const selected = index === this.selected;
		const pointer = selected ? this.theme.fg("accent", "❯ ") : "  ";
		const source = selected
			? this.theme.fg("accent", sourceLabel(item))
			: this.theme.fg("muted", sourceLabel(item));
		const text = selected
			? this.theme.fg("text", preview(item.text, 78))
			: this.theme.fg("dim", preview(item.text, 78));
		const img = item.hasImages ? this.theme.fg("warning", " 🖼") : "";
		const cwd = this.theme.fg("dim", relative(homedir(), item.cwd) || item.cwd);
		const prompt = item.kind === "stash" ? "" : ` ${text}`;
		return `${pointer}${source}${img} ${this.theme.fg("dim", dateLabel(item.timestamp))}${prompt} ${cwd}`;
	}

	override render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(line, width));
	}
}

async function autoStashCurrentEditor(
	ctx: ExtensionContext,
	replacementText: string,
): Promise<boolean> {
	const current = ctx.ui.getEditorText?.() ?? "";
	if (!current.trim() || current === replacementText) return false;
	await insertStash(current, ctx.cwd);
	return true;
}

async function applyItem(
	ctx: ExtensionContext,
	item: PromptItem,
	action: "apply" | "pop",
): Promise<void> {
	const savedCurrent = await autoStashCurrentEditor(ctx, item.text);
	ctx.ui.setEditorText?.(item.text);
	if (action === "pop" && item.kind === "stash" && typeof item.id === "number")
		await deleteStash(item.id);
	await updateStashHud(ctx);
	const verb = action === "pop" ? "Popped" : "Applied";
	ctx.ui.notify(
		`${verb} ${sourceLabel(item)}${savedCurrent ? "; current draft auto-stashed" : ""}`,
		"info",
	);
}

async function stashEditor(ctx: ExtensionContext): Promise<void> {
	const text = ctx.ui.getEditorText?.() ?? "";
	if (!text.trim()) {
		ctx.ui.notify("Nothing to stash — editor is empty.", "warning");
		return;
	}
	await insertStash(text, ctx.cwd);
	ctx.ui.setEditorText?.("");
	await updateStashHud(ctx);
	ctx.ui.notify(`Stashed: ${preview(text, 60)}`, "info");
}

async function pick(
	ctx: ExtensionContext,
	title: string,
	items: PromptItem[],
	config: Config,
	mode: PromptKind,
): Promise<PickerResult | null> {
	if (items.length === 0) {
		ctx.ui.notify(
			mode === "stash" ? "No stashes." : "No prompt history found.",
			"info",
		);
		return null;
	}
	return await ctx.ui.custom<PickerResult | null>(
		(tui, theme, _keybindings, done) => {
			return new PromptPicker(tui, theme, title, items, config, mode, done);
		},
	);
}

async function openStashPicker(
	ctx: ExtensionContext,
	config: Config,
): Promise<void> {
	while (true) {
		const result = await pick(
			ctx,
			"Prompt Stash",
			await listStashes(ctx.cwd),
			config,
			"stash",
		);
		if (!result) return;
		if (result.action === "drop") {
			if (typeof result.item.id === "number") await deleteStash(result.item.id);
			await updateStashHud(ctx);
			ctx.ui.notify(`Dropped ${sourceLabel(result.item)}`, "info");
			continue;
		}
		await applyItem(
			ctx,
			result.item,
			result.action === "pop" ? "pop" : "apply",
		);
		return;
	}
}

async function smartPop(ctx: ExtensionContext, config: Config): Promise<void> {
	const stashes = await listStashes(ctx.cwd);
	if (stashes.length === 0) {
		ctx.ui.notify("No stashes.", "info");
		return;
	}
	if (stashes.length === 1) {
		await applyItem(ctx, stashes[0]!, "pop");
		return;
	}
	await openStashPicker(ctx, config);
}

async function openHistoryPicker(
	ctx: ExtensionContext,
	config: Config,
): Promise<void> {
	refreshProjectHistorySoon(ctx.cwd, config);
	const result = await pick(
		ctx,
		"Prompt History",
		await listHistory(ctx, config),
		config,
		"history",
	);
	if (!result) return;
	await applyItem(ctx, result.item, "apply");
}

function shortcutKey(value: string): ShortcutKey {
	return value as ShortcutKey;
}

function runEditorAction(
	ctx: ExtensionContext,
	action: () => Promise<void>,
): void {
	void action().catch((error) => {
		ctx.ui.notify(`Prompt storage failed: ${errorMessage(error)}`, "error");
	});
}

function installStashHud(ctx: ExtensionContext): void {
	if (stashHudLines.length === 0) {
		clearStashHud(ctx);
		return;
	}
	ctx.ui.setWidget(stashHudWidgetId, (tui, theme) => {
		stashHud = new StashHudWidget(tui, theme);
		return stashHud;
	});
}

function restackStashHud(ctx: ExtensionContext): void {
	if (stashHudLines.length === 0) {
		clearStashHud(ctx);
		return;
	}
	if (restackTimer) clearTimeout(restackTimer);
	restackTimer = setTimeout(() => {
		restackTimer = undefined;
		try {
			installStashHud(ctx);
		} catch (error) {
			if (!errorMessage(error).includes("ctx is stale")) throw error;
		}
	}, 0);
}

function installEditorShortcuts(ctx: ExtensionContext, config: Config): void {
	const ui = ctx.ui as unknown as EditorUi;
	if (typeof ui.getEditorComponent !== "function") return;
	const previous = ui.getEditorComponent();
	if (
		previous &&
		(previous as unknown as Record<symbol, boolean>)[wrappedFactory]
	)
		return;

	const wrapped: EditorFactory = (tui, theme, keybindings) => {
		const editor =
			previous?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings);
		const previousHandleInput = editor.handleInput?.bind(editor);
		editor.handleInput = (data: string) => {
			if (matchesKey(data, shortcutKey(config.shortcuts.stash))) {
				runEditorAction(ctx, () => stashEditor(ctx));
				return;
			}
			if (matchesKey(data, shortcutKey(config.shortcuts.pop))) {
				runEditorAction(ctx, () => smartPop(ctx, config));
				return;
			}
			if (matchesKey(data, shortcutKey(config.shortcuts.history))) {
				runEditorAction(ctx, () => openHistoryPicker(ctx, config));
				return;
			}
			previousHandleInput?.(data);
		};
		return editor;
	};
	(wrapped as unknown as Record<symbol, boolean>)[wrappedFactory] = true;
	ui.setEditorComponent(wrapped);
}

export default function promptStorage(pi: ExtensionAPI) {
	const config = loadConfig();
	if (!config.enabled) return;

	pi.on("session_start", async (_event, ctx) => {
		installEditorShortcuts(ctx, config);
		await updateStashHud(ctx);
		restackStashHud(ctx);
		refreshProjectHistorySoon(ctx.cwd, config);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		restackStashHud(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		restackStashHud(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		restackStashHud(ctx);
	});

	pi.on("message_start", async (_event, ctx) => {
		restackStashHud(ctx);
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		restackStashHud(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		restackStashHud(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		restackStashHud(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (restackTimer) clearTimeout(restackTimer);
		restackTimer = undefined;
		stashHud = undefined;
		db?.close();
		db = undefined;
	});
}
