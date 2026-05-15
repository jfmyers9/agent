export function terminalRows(): number | undefined {
	const rows = process.stdout?.rows;
	return typeof rows === "number" && Number.isFinite(rows) ? rows : undefined;
}

export function hasEnoughTerminalRows(minRows: number): boolean {
	const rows = terminalRows();
	return rows === undefined || rows >= minRows;
}
