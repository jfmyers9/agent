import { describe, expect, test } from "bun:test";
import {
	formatSpawnLaneEntries,
	formatSpawnMap,
	parseMux,
	parsePlacement,
	spawnResultText,
	toolRequest,
	zellijSessionCleanupCommand,
} from "./index";

describe("spawn parsing", () => {
	test("accepts zellij, pty, and hidden placement aliases", () => {
		expect(parseMux("zellij")).toBe("zellij");
		expect(parseMux("pty")).toBe("pty");
		expect(parseMux("no-mux")).toBe("pty");
		expect(parsePlacement("hidden")).toBe("hidden");
		expect(parsePlacement("background")).toBe("hidden");
	});

	test("accepts targetMuxWorkspace while preserving targetMuxSession compatibility", () => {
		const request = toolRequest(
			{
				runtime: "shell",
				placement: "hidden",
				targetMuxWorkspace: " dev ",
			},
			{ cwd: "/repo" } as any,
		);

		expect(request.targetMuxWorkspace).toBe("dev");
		expect(request.targetMuxSession).toBeUndefined();
	});

	test("defaults pty alias to hidden placement", () => {
		const request = toolRequest(
			{
				runtime: "command",
				mux: "pty",
				command: "echo ok",
			},
			{ cwd: "/repo" } as any,
		);

		expect(request.mux).toBe("pty");
		expect(request.placement).toBe("hidden");
	});
});

describe("spawn command wrappers", () => {
	test("wraps owned hidden zellij commands with session cleanup", () => {
		const command = zellijSessionCleanupCommand("printf ok", "/tmp/owned-session.done");

		expect(command).toContain("printf ok");
		expect(command).toContain("touch /tmp/owned-session.done");
		expect(command).toContain('exit "$status"');
	});
});

describe("spawn lane records", () => {
	const baseEntry = {
		id: "lane-1",
		runtime: "pi",
		relation: "child",
		payload: "direct",
		placement: "new-window",
		parent: { sessionPath: "/sessions/parent.jsonl", cwd: "/repo", name: "parent" },
		child: {
			runtime: "pi",
			sessionPath: "/sessions/child.jsonl",
			parentSessionPath: "/sessions/parent.jsonl",
			cwd: "/repo",
			name: "inspect-docs",
		},
		promptPath: "/tmp/prompt.md",
		goal: "Inspect docs",
		createdAt: 0,
		implementation: {
			runtime: {
				runtime: "pi",
				sessionPath: "/sessions/child.jsonl",
				parentSessionPath: "/sessions/parent.jsonl",
				cwd: "/repo",
				name: "inspect-docs",
			},
		},
	};

	test("formats legacy tmux spawn-lane records", () => {
		const text = formatSpawnLaneEntries([
			{
				...baseEntry,
				mux: "tmux",
				implementation: {
					...baseEntry.implementation,
					mux: {
						mux: "tmux",
						tmux: {
							session: "dev",
							windowId: "dev:3",
							windowName: "inspect-docs",
							paneId: "%42",
							placement: "new-window",
						},
					},
				},
			},
		] as any);

		expect(text).toContain("## 1. inspect-docs");
		expect(text).toContain("- Mux: tmux");
		expect(text).toContain("- Pane: %42");
		expect(text).toContain("- Window: dev:3");
		expect(text).toContain("- Child session: /sessions/child.jsonl");
	});

	test("formats zellij and workspace details without top-level backend clutter", () => {
		const entry = {
			...baseEntry,
			mux: "zellij",
			targetMuxWorkspace: "dev",
			implementation: {
				...baseEntry.implementation,
				mux: {
					mux: "zellij",
					zellij: {
						session: "dev",
						tabId: "7",
						tabName: "inspect-docs",
						paneId: "terminal_8",
						placement: "split-pane",
					},
				},
			},
		};

		const listText = formatSpawnLaneEntries([entry] as any);
		const resultText = spawnResultText(entry as any);

		expect(listText).toContain("- Target mux workspace: dev");
		expect(listText).toContain("- Zellij session: dev");
		expect(listText).toContain("- Zellij tab: 7");
		expect(listText).toContain("- Zellij pane: terminal_8");
		expect(resultText).toContain("Target mux workspace: dev");
		expect(resultText).toContain("Zellij pane: terminal_8");
		expect(resultText).not.toContain("[object Object]");
	});

	test("formats legacy hidden PTY entries", () => {
		const text = formatSpawnLaneEntries([
			{
				...baseEntry,
				placement: "hidden",
				mux: "pty",
				implementation: {
					...baseEntry.implementation,
					mux: {
						mux: "pty",
						pty: { pid: 1234, name: "inspect-docs", placement: "hidden" },
					},
				},
			},
		] as any);

		expect(text).toContain("- Placement: hidden");
		expect(text).toContain("- Mux: pty");
		expect(text).toContain("- PTY pid: 1234");
	});

	test("formats pty alias entries as hidden zellij sessions", () => {
		const text = formatSpawnLaneEntries([
			{
				...baseEntry,
				placement: "hidden",
				mux: "zellij",
				implementation: {
					...baseEntry.implementation,
					mux: {
						mux: "zellij",
						zellij: {
							session: "inspect-docs",
							tabId: "9",
							tabName: "inspect-docs",
							placement: "hidden",
							sessionOwned: true,
						},
					},
				},
			},
		] as any);

		expect(text).toContain("- Placement: hidden");
		expect(text).toContain("- Mux: zellij");
		expect(text).toContain("- Zellij session: inspect-docs");
		expect(text).toContain("- Zellij tab: 9");
	});
});

describe("spawn map", () => {
	test("uses session topology without reading mosaic heartbeat state", () => {
		const map = formatSpawnMap({
			sessionManager: {
				getSessionFile: () => "/sessions/parent.jsonl",
				getSessionDir: () => "",
			},
		} as any);

		expect(map).not.toContain("mosaic");
		expect(map).not.toContain("heartbeat");
		expect(map).toContain("session");
	});
});
