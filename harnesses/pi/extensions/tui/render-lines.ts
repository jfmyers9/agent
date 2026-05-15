import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ESCAPE_PATTERN = "\\x1B";
const RESET_ANSI = new RegExp(`${ESCAPE_PATTERN}\\[0m`, "g");
const RESET = "\x1b[0m";
type Rgb = [number, number, number];

export function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, width, "");
	const spaces = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${spaces}`;
}

function truecolorBgAnsi(rgb: Rgb): string {
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function backgroundAnsi(uiTheme: Theme, color: "customMessageBg"): string | undefined {
	const withGetter = uiTheme as Theme & { getBgAnsi?: (color: "customMessageBg") => string };
	if (withGetter.getBgAnsi) return withGetter.getBgAnsi(color);

	const sample = uiTheme.bg(color, " ");
	const spaceIndex = sample.indexOf(" ");
	return spaceIndex >= 0 ? sample.slice(0, spaceIndex) : undefined;
}

function backgroundRgb(uiTheme: Theme, color: "customMessageBg"): Rgb | undefined {
	const ansi = backgroundAnsi(uiTheme, color);
	const truecolor = ansi?.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
	if (!truecolor) return undefined;
	return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
}

function scaleRgb([red, green, blue]: Rgb, factor: number): Rgb {
	const scale = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
	return [scale(red), scale(green), scale(blue)];
}

export function fillBackgroundLine(
	uiTheme: Theme,
	content: string,
	width: number,
	options: { darken?: number } = {},
): string {
	const filled = fillLine(content, width);
	let backgroundStart = backgroundAnsi(uiTheme, "customMessageBg");
	if (options.darken !== undefined) {
		const rgb = backgroundRgb(uiTheme, "customMessageBg");
		if (rgb) backgroundStart = truecolorBgAnsi(scaleRgb(rgb, options.darken));
	}
	if (!backgroundStart) return uiTheme.bg("customMessageBg", filled);

	const backgroundEnd = "\x1b[49m";
	return `${backgroundStart}${filled.replace(RESET_ANSI, `${RESET}${backgroundStart}`)}${backgroundEnd}`;
}

export const ANSI_RESET = RESET;
