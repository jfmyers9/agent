import { describe, expect, test } from "bun:test";
import { resolveLaneBackend, TmuxLanePlacement, ZellijLanePlacement } from "./lane-placement";

describe("lane placement", () => {
	test("resolves auto backend to tmux when tmux is available", async () => {
		const backend = await resolveLaneBackend({
			requested: "auto",
			tmuxAvailable: async () => true,
			zellijAvailable: async () => true,
		});

		expect(backend).toBe("tmux");
	});

	test("resolves auto backend to current zellij before persistent zellij", async () => {
		const backend = await resolveLaneBackend({
			requested: "auto",
			currentBackend: "zellij",
			tmuxAvailable: async () => false,
			zellijAvailable: async () => true,
		});

		expect(backend).toBe("zellij");
	});

	test("rejects auto backend when no multiplexer is available", async () => {
		await expect(
			resolveLaneBackend({
				requested: "auto",
				tmuxAvailable: async () => false,
				zellijAvailable: async () => false,
			}),
		).rejects.toThrow("tmux or zellij backend is unavailable");
	});

	test("resolves pty alias to zellij", async () => {
		const backend = await resolveLaneBackend({
			requested: "pty",
			tmuxAvailable: async () => true,
			zellijAvailable: async () => true,
		});

		expect(backend).toBe("zellij");
	});

	test("requires zellij for pty alias", async () => {
		await expect(
			resolveLaneBackend({
				requested: "pty",
				tmuxAvailable: async () => true,
				zellijAvailable: async () => false,
			}),
		).rejects.toThrow("zellij backend is unavailable");
	});

	test("resolves auto backend to zellij when tmux is unavailable", async () => {
		const backend = await resolveLaneBackend({
			requested: "auto",
			tmuxAvailable: async () => false,
			zellijAvailable: async () => true,
		});

		expect(backend).toBe("zellij");
	});

	test("places a tmux lane in the next available window", async () => {
		const commands: string[][] = [];
		const tmux = new TmuxLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "show-options") return "1";
				if (args[0] === "list-windows") return "1\n2\n";
				if (args[0] === "new-window") return "%42";
				throw new Error(`unexpected tmux call: ${args.join(" ")}`);
			},
		});

		const placed = await tmux.place({
			placement: "new-window",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			targetWorkspace: "dev",
		});

		expect(placed).toEqual({
			backend: "tmux",
			tmux: {
				session: "dev",
				windowId: "dev:3",
				windowName: "lane",
				paneId: "%42",
				placement: "new-window",
			},
		});
		expect(commands.at(-1)).toEqual([
			"new-window",
			"-P",
			"-F",
			"#{pane_id}",
			"-t",
			"dev:3",
			"-n",
			"lane",
			"-c",
			"/repo",
			"echo ok",
		]);
	});

	test("places a tmux lane in a split pane with direction and size", async () => {
		const commands: string[][] = [];
		const tmux = new TmuxLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "display-message" && args.at(-1) === "#S") return "dev";
				if (args[0] === "display-message" && args.at(-1) === "#S:#I") return "dev:2";
				if (args[0] === "split-window") return "%43";
				throw new Error(`unexpected tmux call: ${args.join(" ")}`);
			},
		});

		const placed = await tmux.place({
			placement: "split-pane",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			splitDirection: "horizontal",
			splitSizePercent: 30,
		});

		expect(placed).toEqual({
			backend: "tmux",
			tmux: {
				session: "dev",
				windowId: "dev:2",
				windowName: "lane",
				paneId: "%43",
				placement: "split-pane",
				splitDirection: "horizontal",
				splitSizePercent: 30,
			},
		});
		expect(commands.at(-1)).toEqual([
			"split-window",
			"-h",
			"-p",
			"30",
			"-P",
			"-F",
			"#{pane_id}",
			"-c",
			"/repo",
			"echo ok",
		]);
	});

	test("places a tmux split against a target pane", async () => {
		const commands: string[][] = [];
		const tmux = new TmuxLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "display-message" && args.includes("-t")) return "dev:2";
				if (args[0] === "display-message" && args.at(-1) === "#S") return "dev";
				if (args[0] === "split-window") return "%44";
				throw new Error(`unexpected tmux call: ${args.join(" ")}`);
			},
		});

		const placed = await tmux.place({
			placement: "split-pane",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			targetPane: "%10",
			splitDirection: "vertical",
		});

		expect(placed.tmux.windowId).toBe("dev:2");
		expect(commands.at(-1)).toEqual([
			"split-window",
			"-v",
			"-P",
			"-F",
			"#{pane_id}",
			"-t",
			"%10",
			"-c",
			"/repo",
			"echo ok",
		]);
	});

	test("normalizes target workspace names before building tmux targets", async () => {
		const commands: string[][] = [];
		const tmux = new TmuxLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "show-options") return "0";
				if (args[0] === "list-windows") return "0\n";
				if (args[0] === "new-window") return "%45";
				throw new Error(`unexpected tmux call: ${args.join(" ")}`);
			},
		});

		await tmux.place({
			placement: "new-window",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			targetWorkspace: " dev ",
		});

		expect(commands.find((args) => args[0] === "show-options")).toContain("dev");
		expect(commands.at(-1)).toContain("dev:1");
	});

	test("places a detached tmux window with env and captured window id", async () => {
		const commands: string[][] = [];
		const tmux = new TmuxLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "show-options") return "0";
				if (args[0] === "list-windows") return "";
				if (args[0] === "new-window") return "@7 %47";
				throw new Error(`unexpected tmux call: ${args.join(" ")}`);
			},
		});

		const placed = await tmux.place({
			placement: "new-window",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			targetWorkspace: "dev",
			detached: true,
			captureWindowId: true,
			env: { MOSAIC_OWNER: "%1", MOSAIC_BOOTSTRAP_FILE: "/tmp/bootstrap.json" },
		});

		expect(placed.tmux).toMatchObject({ session: "dev", windowId: "@7", paneId: "%47" });
		expect(commands.at(-1)).toEqual([
			"new-window",
			"-d",
			"-P",
			"-F",
			"#{window_id} #{pane_id}",
			"-t",
			"dev:0",
			"-n",
			"lane",
			"-c",
			"/repo",
			"-e",
			"MOSAIC_OWNER=%1",
			"-e",
			"MOSAIC_BOOTSTRAP_FILE=/tmp/bootstrap.json",
			"echo ok",
		]);
	});

	test("places a hidden tmux lane in a detached session", async () => {
		const commands: string[][] = [];
		const tmux = new TmuxLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "new-session") return "$9 @9 %44";
				throw new Error(`unexpected tmux call: ${args.join(" ")}`);
			},
		});

		const placed = await tmux.place({
			placement: "hidden",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
		});

		expect(placed).toEqual({
			backend: "tmux",
			tmux: {
				session: "$9",
				windowId: "@9",
				windowName: "lane",
				paneId: "%44",
				placement: "hidden",
			},
		});
		expect(commands.at(-1)).toEqual([
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{session_id} #{window_id} #{pane_id}",
			"-s",
			"lane",
			"-c",
			"/repo",
			"echo ok",
		]);
	});

	test("places a zellij lane in a new tab", async () => {
		const commands: string[][] = [];
		const zellij = new ZellijLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args.includes("new-tab")) return "7";
				throw new Error(`unexpected zellij call: ${args.join(" ")}`);
			},
		});

		const placed = await zellij.place({
			placement: "new-window",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			targetWorkspace: "dev",
			env: { MOSAIC_OWNER: "owner" },
		});

		expect(placed.zellij).toEqual({
			session: "dev",
			tabId: "7",
			tabName: "lane",
			placement: "new-window",
		});
		expect(commands.at(-1)).toEqual([
			"--session",
			"dev",
			"action",
			"new-tab",
			"--name",
			"lane",
			"--cwd",
			"/repo",
			"--",
			"sh",
			"-lc",
			"MOSAIC_OWNER='owner' exec echo ok",
		]);
	});

	test("places a zellij lane in a split pane", async () => {
		const commands: string[][] = [];
		const zellij = new ZellijLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args.includes("new-pane")) return "terminal_8";
				throw new Error(`unexpected zellij call: ${args.join(" ")}`);
			},
		});

		const placed = await zellij.place({
			placement: "split-pane",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			splitDirection: "vertical",
		});

		expect(placed.zellij.paneId).toBe("terminal_8");
		expect(commands.at(-1)).toEqual([
			"action",
			"new-pane",
			"--direction",
			"down",
			"--name",
			"lane",
			"--cwd",
			"/repo",
			"--",
			"sh",
			"-lc",
			"echo ok",
		]);
	});

	test("focuses a target zellij pane before splitting", async () => {
		const commands: string[][] = [];
		const zellij = new ZellijLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args.includes("focus-pane-id")) return "";
				if (args.includes("new-pane")) return "terminal_8";
				throw new Error(`unexpected zellij call: ${args.join(" ")}`);
			},
		});

		await zellij.place({
			placement: "split-pane",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
			targetWorkspace: "dev",
			targetPane: "terminal_1",
			splitDirection: "horizontal",
		});

		expect(commands[0]).toEqual(["--session", "dev", "action", "focus-pane-id", "terminal_1"]);
		expect(commands[1]).toContain("new-pane");
		expect(commands[1]).toContain("right");
	});

	test("places a hidden zellij lane in a background session", async () => {
		const commands: string[][] = [];
		const zellij = new ZellijLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "attach") return "";
				if (args.includes("new-tab")) return "9";
				throw new Error(`unexpected zellij call: ${args.join(" ")}`);
			},
		});

		const placed = await zellij.place({
			placement: "hidden",
			cwd: "/repo",
			name: "lane",
			command: "echo ok",
		});

		expect(placed.zellij).toEqual({
			session: "lane",
			tabId: "9",
			tabName: "lane",
			placement: "hidden",
			sessionOwned: true,
		});
		expect(commands[0]).toEqual(["attach", "--create-background", "lane"]);
		expect(commands[1]).toContain("new-tab");
	});

	test("compacts owned hidden zellij session names to avoid long socket paths", async () => {
		const commands: string[][] = [];
		const zellij = new ZellijLanePlacement({
			exec: async (args) => {
				commands.push(args);
				if (args[0] === "attach") return "";
				if (args.includes("new-tab")) return "9";
				throw new Error(`unexpected zellij call: ${args.join(" ")}`);
			},
		});

		const placed = await zellij.place({
			placement: "hidden",
			cwd: "/repo",
			name: "tool-smoke-pty-autoclean-all",
			command: "echo ok",
		});

		expect(placed.zellij.session).not.toBe("tool-smoke-pty-autoclean-all");
		expect(placed.zellij.session?.length).toBeLessThanOrEqual(16);
		expect(commands[0]).toEqual(["attach", "--create-background", placed.zellij.session]);
	});
});
