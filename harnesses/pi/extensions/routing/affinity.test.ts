import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASSESSMENT_ENTRY, pendingAssessment } from "./affinity";

test("only the latest valid branch request is eligible and consumed IDs do not revive older requests", () => {
	const entries: unknown[] = [];
	const ctx = { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
	const add = (data: unknown, customType = ASSESSMENT_ENTRY) => entries.push({ type: "custom", customType, data });
	expect(pendingAssessment(ctx)).toBeUndefined();
	add({ version: 1, id: "old", mode: "reassess" });
	add({ version: 1, id: "new", mode: "reset" });
	add({ version: 2, id: "future", mode: "reset" });
	add({ version: 1, id: "bad", mode: "other" });
	add({ version: 1, id: "", mode: "reset" });
	add({ version: 1, id: "unrelated", mode: "reset" }, "other");
	expect(pendingAssessment(ctx)).toEqual({ version: 1, id: "new", mode: "reset" });
	expect(pendingAssessment(ctx, { assessmentId: "new" })).toBeUndefined();
	expect(pendingAssessment(ctx, { assessmentId: "old" })?.id).toBe("new");
	entries.splice(1);
	expect(pendingAssessment(ctx)?.id).toBe("old");
	expect(pendingAssessment(ctx, { assessmentId: "old" })).toBeUndefined();
});
