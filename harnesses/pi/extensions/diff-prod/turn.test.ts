import { expect, test } from "bun:test";
import { TurnDiff } from "./turn";

test("merges consecutive writes, excludes pre-existing changes and drops reverted edits", () => {
	const turn = new TurnDiff();
	const record = (before: string, after: string) => turn.record({ path: "/repo/app.ts", before, after });
	// This is already dirty relative to HEAD; only changes from here are relevant.
	record("pre-existing\none\n", "pre-existing\ntwo\n");
	record("pre-existing\ntwo\n", "pre-existing\nthree\n");
	const diff = turn.read("/repo");
	expect(diff).toContain("-one");
	expect(diff).toContain("+three");
	expect(diff).not.toContain("+two");
	expect(diff).not.toContain("+pre-existing");
	expect(diff.match(/Edited: app.ts/g)).toHaveLength(1);
	record("pre-existing\nthree\n", "pre-existing\none\n");
	expect(turn.read("/repo")).toBe("");
});

test("intervening external changes are not attributed or combined", () => {
	const turn = new TurnDiff();
	turn.record({ path: "/repo/a", before: "one\n", after: "two\n" });
	turn.record({ path: "/repo/a", before: "external\ntwo\n", after: "external\nthree\n" });
	const diff = turn.read("/repo");
	expect(diff).toContain("Interleaved changes detected");
	expect(diff.match(/Edited: a/g)).toHaveLength(2);
	expect(diff).not.toContain("+external");
	expect(diff).toContain("+two");
	expect(diff).toContain("+three");
});

test("new and empty files, deletion, moves as delete/add, and binary changes", () => {
	const turn = new TurnDiff();
	turn.record({ path: "/repo/new.test.ts", before: null, after: "test\n" });
	turn.record({ path: "/repo/empty", before: null, after: "" });
	turn.record({ path: "/repo/old", before: "moved\n", after: null });
	turn.record({ path: "/repo/moved", before: null, after: "moved\n" });
	turn.record({ path: "/repo/binary", before: "\0one", after: "\0two" });
	const diff = turn.read("/repo");
	expect(diff).toContain("Added: new.test.ts");
	expect(diff).toContain("Added: empty");
	expect(diff).toContain("Deleted: old");
	expect(diff).toContain("Added: moved");
	expect(diff).toContain("Binary file changed: binary");
	expect(diff).not.toContain("\0");
	turn.record({ path: "/repo/empty", before: "", after: null });
	expect(turn.read("/repo")).not.toContain("Added: empty");
	turn.reset();
	expect(turn.read("/repo")).toBe("");
});

test("unknown snapshots break continuity and oversized previews are labeled", () => {
	const turn = new TurnDiff();
	turn.record({ path: "/repo/a", before: "a\n", after: "b\n" });
	turn.record({ path: "/repo/a", before: "b\n", after: undefined });
	turn.record({ path: "/repo/a", before: "b\n", after: "c\n" });
	expect(turn.read("/repo")).toContain("Changes may be omitted");
	expect(turn.read("/repo").match(/Edited: a/g)).toHaveLength(2);
	turn.reset();
	turn.record({ path: "/repo/large", before: null, after: "line\n".repeat(3000) });
	const diff = turn.read("/repo");
	expect(diff).toContain("Preview truncated");
	expect(diff.split("\n").length).toBeLessThan(2010);
	turn.reset();
	turn.record({ path: "/repo/large", before: null, after: "x".repeat(2_000_001) });
	expect(turn.read("/repo")).toContain("size limit reached");
});
