import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExecSessionManager, ExecSessionRecord } from "../tools/exec-session-manager.ts";

interface OverlayTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

const CHROME_LINES = 7;
const MIN_BODY_LINES = 3;

export class BackgroundTerminalOverlay implements Component {
	focused = true;
	private closed = false;
	private readonly unsubscribe: () => void;
	private selectedIndex = 0;
	private listScrollOffset = 0;
	private mode: "list" | "attached" = "list";
	private attachedSessionId: number | undefined;
	private scrollOffset = 0;
	private autoScroll = true;
	private message: string | undefined;
	private lastOutputInnerWidth = 0;

	constructor(
		private readonly sessions: Pick<ExecSessionManager, "listSessions" | "onSessionUpdate" | "stopSession">,
		private readonly tui: Pick<TUI, "requestRender" | "terminal">,
		private readonly theme: OverlayTheme,
		private readonly done: (result: undefined) => void,
	) {
		this.unsubscribe = sessions.onSessionUpdate(() => {
			if (!this.closed) this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.close();
			return;
		}

		if (this.mode === "attached") {
			this.handleAttachedInput(data);
			return;
		}

		if (isMoveUpKey(data)) {
			this.moveSelection(-1);
			return;
		}
		if (isMoveDownKey(data)) {
			this.moveSelection(1);
			return;
		}
		if (isPageUpKey(data)) {
			this.moveSelection(-Math.max(1, Math.floor((this.tui.terminal.rows - CHROME_LINES) / 2)));
			return;
		}
		if (isPageDownKey(data)) {
			this.moveSelection(Math.max(1, Math.floor((this.tui.terminal.rows - CHROME_LINES) / 2)));
			return;
		}
		if (data === "g" || matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
			this.listScrollOffset = 0;
			this.message = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.selectedIndex = Math.max(0, this.sessions.listSessions().length - 1);
			this.listScrollOffset = this.selectedIndex;
			this.message = undefined;
			this.tui.requestRender();
			return;
		}
		if (isAttachKey(data)) {
			this.attachSelected();
			return;
		}
		if (isKillKey(data)) {
			this.killSelected();
		}
	}

	render(width: number): string[] {
		if (width < 8) return [];
		if (this.mode === "attached") return this.renderAttached(width);
		return this.renderList(width);
	}

	invalidate(): void {}

	dispose(): void {
		this.close(false);
	}

	private renderList(width: number): string[] {
		const innerWidth = width - 4;
		const records = this.sessions.listSessions();
		this.clampSelection(records.length);
		const bodyLimit = Math.max(MIN_BODY_LINES, this.tui.terminal.rows - CHROME_LINES);
		const recordLimit = Math.max(1, Math.floor(bodyLimit / 2));
		this.syncListScroll(records.length, recordLimit);
		const visibleRecords = records.slice(this.listScrollOffset, this.listScrollOffset + recordLimit);
		const body = this.bodyLines(visibleRecords, innerWidth, this.listScrollOffset);
		const visibleBody = body.slice(0, bodyLimit);
		const omittedRecords = records.length - visibleRecords.length;
		const omittedLines = body.length - visibleBody.length;
		const stdinOpen = records.filter((record) => record.stdinOpen).length;

		const lines: string[] = [];
		lines.push(this.borderTop(width));
		lines.push(
			this.row(
				`${this.theme.bold("background terminals")} ${this.theme.fg("dim", `${records.length} visible`)}`,
				innerWidth,
			),
		);
		lines.push(
			this.row(
				this.theme.fg("dim", "j/k move · ctrl-u/d page · enter/l/a attach · x kill · g/G top/bottom · q/esc close"),
				innerWidth,
			),
		);
		lines.push(this.separator(innerWidth));
		if (this.message) lines.push(this.row(this.theme.fg("accent", this.message), innerWidth));
		for (const line of visibleBody) lines.push(this.row(line, innerWidth));
		if (omittedRecords > 0 || omittedLines > 0) {
			const omitted = Math.max(omittedRecords, omittedLines);
			lines.push(
				this.row(this.theme.fg("dim", `... ${omitted} more terminal${omitted === 1 ? "" : "s"}`), innerWidth),
			);
		}
		lines.push(this.separator(innerWidth));
		lines.push(
			this.row(
				this.theme.fg(
					"dim",
					`${records.length} background terminal${records.length === 1 ? "" : "s"}${stdinOpen > 0 ? ` · ${stdinOpen} tty` : ""}`,
				),
				innerWidth,
			),
		);
		lines.push(this.borderBottom(width));
		return lines;
	}

	private close(callDone = true): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		if (callDone) this.done(undefined);
	}

	private bodyLines(records: ExecSessionRecord[], width: number, indexOffset: number): string[] {
		if (records.length === 0) return [this.theme.fg("muted", "No background terminals")];
		const lines: string[] = [];
		for (const [index, record] of records.entries()) {
			lines.push(this.sessionLine(record, width, index + indexOffset === this.selectedIndex));
			const recent = recentOutputLine(record.output);
			if (recent) {
				lines.push(this.theme.fg("dim", `  ${truncatePlain(`last: ${recent}`, Math.max(8, width - 2))}`));
			}
		}
		return lines;
	}

	private sessionLine(record: ExecSessionRecord, width: number, selected: boolean): string {
		const state = record.running
			? this.theme.fg("accent", "running")
			: this.theme.fg("muted", `exited ${record.exitCode ?? 0}`);
		const prefix = `${selected ? this.theme.fg("accent", ">") : " "} #${record.id} `;
		const tty = record.stdinOpen ? `${this.theme.fg("dim", " · ")}${this.theme.fg("mdLink", "tty")}` : "";
		const meta = `${state}${tty}${this.theme.fg("dim", " · ")}`;
		return truncateToWidth(`${prefix}${meta}${sanitizeLine(record.command)}`, width, "...");
	}

	private handleAttachedInput(data: string): void {
		const lines = this.attachedOutputLines();
		const viewportHeight = this.attachedViewportHeight();
		const maxScroll = Math.max(0, lines.length - viewportHeight);

		if (data === "h" || data === "b" || matchesKey(data, Key.left)) {
			this.mode = "list";
			this.attachedSessionId = undefined;
			this.scrollOffset = 0;
			this.autoScroll = true;
			this.message = undefined;
			this.tui.requestRender();
			return;
		}
		if (isMoveUpKey(data)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (isMoveDownKey(data)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (isPageUpKey(data)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
			this.autoScroll = false;
			this.tui.requestRender();
			return;
		}
		if (isPageDownKey(data)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
			this.autoScroll = this.scrollOffset >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (data === "g" || matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			this.autoScroll = false;
			this.tui.requestRender();
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
			this.tui.requestRender();
			return;
		}
		if (isKillKey(data)) {
			this.killAttached();
		}
	}

	private renderAttached(width: number): string[] {
		const innerWidth = width - 4;
		const records = this.sessions.listSessions();
		const record = records.find((item) => item.id === this.attachedSessionId);
		if (!record) {
			this.mode = "list";
			this.attachedSessionId = undefined;
			this.message = "attached terminal disappeared";
			return this.renderList(width);
		}
		const outputLines = outputLinesForRender(record.output, innerWidth);
		this.lastOutputInnerWidth = innerWidth;
		const viewportHeight = this.attachedViewportHeight();
		const maxScroll = Math.max(0, outputLines.length - viewportHeight);
		if (this.autoScroll) this.scrollOffset = maxScroll;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visibleOutput = outputLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);

		const state = record.running
			? this.theme.fg("accent", "running")
			: this.theme.fg("muted", `exited ${record.exitCode ?? 0}`);
		const lines: string[] = [];
		lines.push(this.borderTop(width));
		lines.push(
			this.row(
				`${this.theme.bold(`background terminal #${record.id}`)} ${this.theme.fg("dim", "attached")}`,
				innerWidth,
			),
		);
		lines.push(
			this.row(
				this.theme.fg("dim", "j/k scroll · ctrl-u/d page · g/G top/bottom · h back · x kill · q/esc close"),
				innerWidth,
			),
		);
		lines.push(this.row(`${state}${this.theme.fg("dim", " · ")}${sanitizeLine(record.command)}`, innerWidth));
		lines.push(this.separator(innerWidth));
		if (visibleOutput.length === 0) {
			lines.push(this.row(this.theme.fg("muted", "No output yet"), innerWidth));
		} else {
			for (const line of visibleOutput) lines.push(this.row(line, innerWidth));
		}
		lines.push(this.separator(innerWidth));
		lines.push(
			this.row(
				this.theme.fg(
					"dim",
					`${outputLines.length} line${outputLines.length === 1 ? "" : "s"} · ${outputLines.length === 0 ? "0-0" : `${this.scrollOffset + 1}-${Math.min(outputLines.length, this.scrollOffset + viewportHeight)}`}`,
				),
				innerWidth,
			),
		);
		lines.push(this.borderBottom(width));
		return lines;
	}

	private attachedViewportHeight(): number {
		return Math.max(MIN_BODY_LINES, this.tui.terminal.rows - 8);
	}

	private attachedOutputLines(): string[] {
		const record = this.sessions.listSessions().find((item) => item.id === this.attachedSessionId);
		if (!record) return [];
		return outputLinesForRender(record.output, this.lastOutputInnerWidth || 80);
	}

	private moveSelection(delta: number): void {
		const records = this.sessions.listSessions();
		if (records.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(records.length - 1, this.selectedIndex + delta));
		this.syncListScroll(records.length, Math.max(1, Math.floor((this.tui.terminal.rows - CHROME_LINES) / 2)));
		this.message = undefined;
		this.tui.requestRender();
	}

	private attachSelected(): void {
		const records = this.sessions.listSessions();
		this.clampSelection(records.length);
		const record = records[this.selectedIndex];
		if (!record) {
			this.message = "No background terminal selected";
			this.tui.requestRender();
			return;
		}
		this.mode = "attached";
		this.attachedSessionId = record.id;
		this.scrollOffset = 0;
		this.autoScroll = true;
		this.message = undefined;
		this.tui.requestRender();
	}

	private killSelected(): void {
		const records = this.sessions.listSessions();
		this.clampSelection(records.length);
		const record = records[this.selectedIndex];
		if (!record) {
			this.message = "No background terminal selected";
			this.tui.requestRender();
			return;
		}
		const killed = this.sessions.stopSession(record.id);
		this.message = killed ? `Killed background terminal #${record.id}` : `Background terminal #${record.id} is gone`;
		this.clampSelection(this.sessions.listSessions().length);
		this.tui.requestRender();
	}

	private killAttached(): void {
		const sessionId = this.attachedSessionId;
		if (sessionId === undefined) return;
		const killed = this.sessions.stopSession(sessionId);
		this.mode = "list";
		this.attachedSessionId = undefined;
		this.scrollOffset = 0;
		this.autoScroll = true;
		this.message = killed ? `Killed background terminal #${sessionId}` : `Background terminal #${sessionId} is gone`;
		this.clampSelection(this.sessions.listSessions().length);
		this.tui.requestRender();
	}

	private clampSelection(count: number): void {
		this.selectedIndex = Math.max(0, Math.min(Math.max(0, count - 1), this.selectedIndex));
		this.listScrollOffset = Math.max(0, Math.min(Math.max(0, count - 1), this.listScrollOffset));
	}

	private syncListScroll(count: number, recordLimit: number): void {
		if (count === 0) {
			this.listScrollOffset = 0;
			return;
		}
		if (this.selectedIndex < this.listScrollOffset) {
			this.listScrollOffset = this.selectedIndex;
		}
		if (this.selectedIndex >= this.listScrollOffset + recordLimit) {
			this.listScrollOffset = this.selectedIndex - recordLimit + 1;
		}
		this.listScrollOffset = Math.max(0, Math.min(Math.max(0, count - recordLimit), this.listScrollOffset));
	}

	private row(content: string, innerWidth: number): string {
		const padded = content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return `${this.theme.fg("border", "│")} ${truncateToWidth(padded, innerWidth, "")} ${this.theme.fg("border", "│")}`;
	}

	private separator(innerWidth: number): string {
		return this.row(this.theme.fg("dim", "-".repeat(innerWidth)), innerWidth);
	}

	private borderTop(width: number): string {
		return this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
	}

	private borderBottom(width: number): string {
		return this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
	}
}

function recentOutputLine(output: string): string | undefined {
	const text = output.replace(/\n$/, "");
	if (!text) return undefined;
	const line = text.split("\n").at(-1)?.trim();
	return line ? sanitizeLine(line) : undefined;
}

function sanitizeLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

function truncatePlain(text: string, width: number): string {
	return truncateToWidth(sanitizeLine(text), width, "...");
}

function outputLinesForRender(output: string, width: number): string[] {
	return output
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => truncatePlain(line, Math.max(8, width)))
		.filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

function isMoveUpKey(data: string): boolean {
	return matchesKey(data, Key.up) || data === "k";
}

function isMoveDownKey(data: string): boolean {
	return matchesKey(data, Key.down) || data === "j";
}

function isAttachKey(data: string): boolean {
	return matchesKey(data, Key.enter) || data === "\r" || data === "\n" || data === "l" || data === "a";
}

function isPageUpKey(data: string): boolean {
	return matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u")) || data === "\u0015";
}

function isPageDownKey(data: string): boolean {
	return matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d")) || data === "\u0004";
}

function isKillKey(data: string): boolean {
	return data === "x";
}
