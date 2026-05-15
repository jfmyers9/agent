import { expect, test } from "bun:test";
import { setOrderedAboveEditorWidget } from "./ordered-widgets";

test("orders known above-editor widgets deterministically", () => {
	const calls: Array<{ key: string; content: unknown; placement?: string }> = [];
	const ui = {
		setWidget(key: string, content: unknown, options?: { placement?: string }) {
			calls.push({ key, content, placement: options?.placement });
		},
	};

	setOrderedAboveEditorWidget(ui, "prompt-storage-stash", ["stash"]);
	setOrderedAboveEditorWidget(ui, "background-terminals", ["terminal"]);
	setOrderedAboveEditorWidget(ui, "project-tasks", ["tasks"]);

	expect(calls).toEqual([
		{ key: "prompt-storage-stash", content: ["stash"], placement: "aboveEditor" },
		{ key: "background-terminals", content: undefined, placement: undefined },
		{ key: "prompt-storage-stash", content: undefined, placement: undefined },
		{ key: "background-terminals", content: ["terminal"], placement: "aboveEditor" },
		{ key: "prompt-storage-stash", content: ["stash"], placement: "aboveEditor" },
		{ key: "project-tasks", content: undefined, placement: undefined },
		{ key: "background-terminals", content: undefined, placement: undefined },
		{ key: "prompt-storage-stash", content: undefined, placement: undefined },
		{ key: "project-tasks", content: ["tasks"], placement: "aboveEditor" },
		{ key: "background-terminals", content: ["terminal"], placement: "aboveEditor" },
		{ key: "prompt-storage-stash", content: ["stash"], placement: "aboveEditor" },
	]);
});

test("clears only the requested ordered widget", () => {
	const calls: Array<{ key: string; content: unknown; placement?: string }> = [];
	const ui = {
		setWidget(key: string, content: unknown, options?: { placement?: string }) {
			calls.push({ key, content, placement: options?.placement });
		},
	};

	setOrderedAboveEditorWidget(ui, "project-tasks", ["tasks"]);
	setOrderedAboveEditorWidget(ui, "project-tasks", undefined);

	expect(calls).toEqual([
		{ key: "project-tasks", content: ["tasks"], placement: "aboveEditor" },
		{ key: "project-tasks", content: undefined, placement: undefined },
	]);
});
