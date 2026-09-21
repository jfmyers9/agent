import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { boundTraceValue } from "../../../../../node_modules/@luan.sh/pi-code-mode/src/runtime/trace-values.ts";
import { type DiffRenderRow, EditDiffView } from "../diff-render";

initTheme("dark");

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const diff = "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after\n";
const added: DiffRenderRow = { kind: "add", oldLine: null, newLine: 1, content: "after", path: "example.ts" };

function render(rawDiff: string, rows: unknown, width = 120, expanded = false): string[] {
	return new EditDiffView(rawDiff, rows as DiffRenderRow[], expanded, theme).render(width);
}

const malformed = [
	[added, "[values omitted]"],
	[{ kind: "add", path: "example.ts", traceTruncated: true }],
	[null],
	[{ ...added, content: null }],
	[{ ...added, highlightedContent: 42 }],
	[{ ...added, newLine: "[value limit]" }],
	[{ ...added, path: 42 }],
	[{ ...added, kind: "[value limit]" }],
	"[value limit]",
	{ traceTruncated: true },
	[],
];

for (const [index, rows] of malformed.entries()) {
	test(`reparses the plain diff for malformed cached rows (${index})`, () => {
		for (const width of [60, 120, 240])
			for (const expanded of [false, true]) {
				expect(render(diff, rows, width, expanded)).toEqual(render(diff, undefined, width, expanded));
			}
	});
}

test("keeps valid pre-highlighted rows, including blank lines", () => {
	const rows = [
		{ ...added, highlightedContent: "highlighted after" },
		{ ...added, newLine: 2, content: "" },
	];
	const output = render(diff, rows).map(stripTerminalSequences).join("\n");
	expect(output).toContain("highlighted after");
	expect(output).not.toContain("before");
});

test("renders actual Code Mode bounded metadata without crashing or losing the plain diff", () => {
	const rawDiff =
		"--- a/example.ts\n+++ b/example.ts\n@@ -0,0 +1,1000 @@\n" +
		Array.from({ length: 1000 }, (_, index) => `+line ${index}`).join("\n");
	const rows = Array.from({ length: 1000 }, (_, index) => ({
		...added,
		newLine: index + 1,
		content: `line ${index}`,
		highlightedContent: "x".repeat(100),
	}));
	const bounded = boundTraceValue({ diff: rawDiff, highlightedDiffRows: rows }) as {
		diff: string;
		highlightedDiffRows: unknown[];
	};
	expect(bounded.highlightedDiffRows.at(-1)).toBe("[values omitted]");
	for (const expanded of [false, true]) {
		const lines = render(bounded.diff, bounded.highlightedDiffRows, 120, expanded);
		expect(lines).toEqual(render(rawDiff, undefined, 120, expanded));
		expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
		if (expanded) expect(lines.map(stripTerminalSequences).join("\n")).toContain("line 999");
	}
});

test("falls back across multiple file sections in column layout", () => {
	const multiDiff = diff + diff.replaceAll("example.ts", "second.ts");
	const lines = render(multiDiff, [added, "[values omitted]"], 240, true);
	expect(lines).toEqual(render(multiDiff, undefined, 240, true));
	expect(lines.map(stripTerminalSequences).join("\n")).toContain("second.ts");
});
