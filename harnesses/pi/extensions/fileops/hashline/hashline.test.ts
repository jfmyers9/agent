import { describe, expect, it } from "bun:test";
import { applyEdits } from "./apply";
import { InMemoryFilesystem } from "./fs";
import { Patch } from "./input";
import { HEADTAIL_DRIFT_WARNING } from "./messages";
import { parsePatch } from "./parser";
import { Patcher } from "./patcher";
import { InMemorySnapshotStore, type SnapshotStore } from "./snapshots";

function apply(text: string, diff: string) {
	return applyEdits(text, parsePatch(diff).edits);
}

function record(store: SnapshotStore, path: string, text: string): string {
	return store.recordContiguous(path, 1, text.split("\n"), { fullText: text });
}

describe("hashline replacement boundary repair", () => {
	it("repairs a multi-line duplicated closing block", () => {
		const file = [
			"import React from 'react';",
			"import { Composition } from 'remotion';",
			"",
			"export const RemotionRoot: React.FC = () => {",
			"\treturn (",
			"\t\t<>",
			"\t\t\t<Composition",
			'\t\t\t\tid="Main"',
			"\t\t\t\tcomponent={Main}",
			"\t\t\t\tdurationInFrames={300}",
			"\t\t\t\tfps={30}",
			"\t\t\t\twidth={1920}",
			"\t\t\t\theight={1080}",
			"\t\t\t/>",
			"\t\t</>",
			"\t);",
			"};",
		].join("\n");
		const diff = [
			"7 14",
			"+\t\t\t<Composition",
			'+\t\t\t\tid="Main"',
			"+\t\t\t\tcomponent={Main}",
			"+\t\t\t\tdurationInFrames={600}",
			"+\t\t\t\tfps={30}",
			"+\t\t\t\twidth={1920}",
			"+\t\t\t\theight={1080}",
			"+\t\t\t/>",
			"+\t\t</>",
			"+\t);",
		].join("\n");

		const result = apply(file, diff);

		expect(result.text).toBe(file.replace("durationInFrames={300}", "durationInFrames={600}"));
		expect(result.warnings?.join("\n")).toMatch(/delimiter-balance/);
	});

	it("drops duplicated leading and trailing boundary echoes", () => {
		const file = [
			"func _cmd_travel_homeworld():",
			"\tvar destination = get_homeworld()",
			"\ttravel_to(destination)",
			"\tprint_status()",
		].join("\n");
		const diff = [
			"2 3",
			"+func _cmd_travel_homeworld():",
			"+\tvar destination = find_homeworld()",
			"+\ttravel_to(destination)",
			"+\tprint_status()",
		].join("\n");

		const result = apply(file, diff);

		expect(result.text).toBe(
			[
				"func _cmd_travel_homeworld():",
				"\tvar destination = find_homeworld()",
				"\ttravel_to(destination)",
				"\tprint_status()",
			].join("\n"),
		);
		expect(result.warnings?.join("\n")).toMatch(/boundary echo/);
	});
});

describe("hashline patcher safety diagnostics", () => {
	it("applies an EOF insert with a stale recognized tag and warns", async () => {
		const path = "a.ts";
		const fs = new InMemoryFilesystem([[path, "live\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, path, "older\n");
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`¶${path}#${tag}\nEOF\n+c`));

		expect(result.sections[0].op).toBe("update");
		expect(fs.get(path)).toBe("live\nc\n");
		expect(result.sections[0].warnings).toContain(HEADTAIL_DRIFT_WARNING);
	});

	it("returns a noop result for a single-section no-change apply", async () => {
		const path = "a.ts";
		const text = "same\n";
		const fs = new InMemoryFilesystem([[path, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = record(snapshots, path, text);
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`¶${path}#${tag}\n1 1\n+same`));

		expect(result.sections[0].op).toBe("noop");
		expect(fs.get(path)).toBe(text);
	});

	it("still rejects a noop section inside a multi-section batch", async () => {
		const fs = new InMemoryFilesystem([
			["a.ts", "same\n"],
			["b.ts", "x\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tagA = record(snapshots, "a.ts", "same\n");
		const tagB = record(snapshots, "b.ts", "x\n");
		const patcher = new Patcher({ fs, snapshots });

		await expect(
			patcher.apply(Patch.parse(`¶a.ts#${tagA}\n1 1\n+same\n¶b.ts#${tagB}\n1 1\n+y`)),
		).rejects.toThrow(/no changes/);
		expect(fs.get("b.ts")).toBe("x\n");
	});
});

describe("hashline parser teaching errors", () => {
	it("rejects upstream verb-style replace headers with local guidance", () => {
		expect(() => parsePatch("replace 1..2:\n+x")).toThrow(/Use bare hunk header `1 2`/);
	});

	it("rejects lowercase delete headers with local guidance", () => {
		expect(() => parsePatch("delete 3..4")).toThrow(/Use `DELETE 3 4`/);
	});
});
