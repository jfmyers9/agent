import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DEFAULT_TARGET_COLUMN_WIDTH = 100;
const DEFAULT_COLUMN_GAP = "  ";

export function columnCountForWidth(
	width: number,
	itemCount: number,
	targetWidth = DEFAULT_TARGET_COLUMN_WIDTH,
): number {
	if (itemCount <= 1) return 1;
	return Math.max(1, Math.min(itemCount, Math.floor(width / targetWidth)));
}

export function columnWidthFor(width: number, columnCount: number, gap = DEFAULT_COLUMN_GAP): number {
	return Math.max(1, Math.floor((width - visibleWidth(gap) * (columnCount - 1)) / columnCount));
}

function flattenBlocks(blocks: readonly (readonly string[])[]): string[] {
	return blocks.flatMap((block) => [...block]);
}

function chunkBlocks(blocks: readonly (readonly string[])[], columnCount: number): string[][][] {
	const blocksPerColumn = Math.ceil(blocks.length / columnCount);
	return Array.from({ length: columnCount }, (_, columnIndex) =>
		blocks.slice(columnIndex * blocksPerColumn, (columnIndex + 1) * blocksPerColumn).map((block) => [...block]),
	);
}

function fitColumnLine(line: string | undefined, width: number): string {
	const rendered = truncateToWidth(line ?? "", width, "", true);
	return `${rendered}${" ".repeat(Math.max(0, width - visibleWidth(rendered)))}`;
}

export function renderColumns(
	blocks: readonly (readonly string[])[],
	width: number,
	options: { targetWidth?: number; gap?: string } = {},
): string[] {
	const visibleBlocks = blocks.filter((block) => block.length > 0);
	const columnCount = columnCountForWidth(width, visibleBlocks.length, options.targetWidth);
	if (columnCount <= 1) return flattenBlocks(visibleBlocks);

	const gap = options.gap ?? DEFAULT_COLUMN_GAP;
	const columnWidth = columnWidthFor(width, columnCount, gap);
	const columns = chunkBlocks(visibleBlocks, columnCount).map((columnBlocks) => flattenBlocks(columnBlocks));
	const height = Math.max(...columns.map((column) => column.length));
	const lines: string[] = [];
	for (let row = 0; row < height; row++) {
		lines.push(
			columns
				.map((column) => fitColumnLine(column[row], columnWidth))
				.join(gap)
				.trimEnd(),
		);
	}
	return lines;
}
