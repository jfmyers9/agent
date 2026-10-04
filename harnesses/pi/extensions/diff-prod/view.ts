import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export class DiffView {
	private lines: string[] = [];
	private maxWidth = 0;
	private top = 0;
	private left = 0;
	private height = 1;
	private width = 1;

	constructor(
		diff: string,
		private readonly theme: Theme,
		private readonly rows: () => number,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly paneFocused?: () => boolean,
	) {
		this.update(diff);
	}

	update(diff: string): void {
		// Git content is untrusted terminal text: never allow source-file escape sequences.
		this.lines = diff
			.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�")
			.replace(/\t/g, "    ")
			.replace(/\n$/, "")
			.split("\n");
		this.maxWidth = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.top--;
		if (matchesKey(data, "down") || data === "j") this.top++;
		if (matchesKey(data, "pageUp")) this.top -= this.height;
		if (matchesKey(data, "pageDown") || data === " ") this.top += this.height;
		if (matchesKey(data, "home") || data === "g") this.top = 0;
		if (matchesKey(data, "end") || data === "G") this.top = this.lines.length;
		if (matchesKey(data, "left") || data === "h") this.left -= 8;
		if (matchesKey(data, "right") || data === "l") this.left += 8;
		this.clamp();
		this.requestRender();
	}

	private clamp(): void {
		this.top = Math.max(0, Math.min(this.top, this.lines.length - this.height));
		this.left = Math.max(0, Math.min(this.left, this.maxWidth - this.width));
	}

	render(width: number): string[] {
		this.width = Math.max(1, width);
		this.height = Math.max(1, this.rows() - (this.paneFocused ? 2 : 4));
		this.clamp();
		const fit = (text: string) => truncateToWidth(text, width);
		const body = this.lines.slice(this.top, this.top + this.height).map((line) => {
			const color =
				line.startsWith("diff --git") || line.startsWith("@@")
					? "accent"
					: line.startsWith("+")
						? "success"
						: line.startsWith("-")
							? "error"
							: "text";
			return this.theme.fg(color, sliceByColumn(line, this.left, width));
		});
		return [
			fit(
				this.theme.fg(
					"accent",
					this.paneFocused ? "Production diff · tracked" : "Production diff · staged + unstaged · tracked files only",
				),
			),
			...body,
			fit(
				this.theme.fg(
					"muted",
					this.paneFocused
						? this.paneFocused()
							? "hjkl scroll · g/G · Esc editor"
							: "Ctrl+Alt+D focus · /diff-prod off"
						: `${this.top + 1}–${Math.min(this.top + this.height, this.lines.length)}/${this.lines.length} · ←→/hl pan · ↑↓/jk scroll · PgUp/PgDn · g/G · q/Esc close`,
				),
			),
		];
	}

	invalidate(): void {} // Theme colors and dimensions are evaluated on each render.
}
