import { describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");

function workspace() {
	const home = mkdtempSync(join(tmpdir(), "agent-install-"));
	return {
		home,
		claude: join(home, "claude config"),
		pi: join(home, "pi config"),
		codex: join(home, "codex config"),
		agents: join(home, "agents config"),
	};
}

function install(
	action: "install" | "dry-run" | "doctor" | "validate" | "unlink",
	harness: "claude" | "pi" | "codex",
	paths: ReturnType<typeof workspace>,
	environment: NodeJS.ProcessEnv = {},
	checkout = root,
) {
	return spawnSync("bash", [join(checkout, "install.sh"), action, harness], {
		cwd: checkout,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: paths.home,
			CLAUDE_CONFIG_DIR: paths.claude,
			PI_CONFIG_DIR: paths.pi,
			CODEX_CONFIG_DIR: paths.codex,
			CODEX_AGENTS_DIR: paths.agents,
			CODEX_SKIP_PACKAGES: "1",
			...environment,
		},
	});
}

function piCheckout(home: string) {
	const checkout = join(home, "checkout");
	mkdirSync(checkout);
	for (const source of ["install.sh", "global", "rules", "skills", "bin", "harnesses"]) {
		symlinkSync(join(root, source), join(checkout, source));
	}
	// Exercise installation without downloading packages or rebuilding Rust.
	mkdirSync(join(checkout, "node_modules"));
	mkdirSync(join(checkout, "target/release"), { recursive: true });
	writeFileSync(join(checkout, "target/release/context-guard"), "fixture\n");
	const buildBin = join(home, "build-bin");
	mkdirSync(buildBin);
	for (const command of ["mise", "bun", "cargo"]) {
		writeFileSync(join(buildBin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	}
	return { checkout, environment: { PATH: `${buildBin}:${process.env.PATH}` } };
}

describe("installer safety", () => {
	test("clean install is idempotent and validates", () => {
		const paths = workspace();
		const first = install("install", "claude", paths);
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(readFileSync(join(paths.claude, "AGENTS.md"), "utf8")).toBe(
			readFileSync(join(root, "global/AGENTS.md"), "utf8"),
		);
		expect(readFileSync(join(paths.claude, "CLAUDE.md"), "utf8")).toBe(
			readFileSync(join(root, "global/CLAUDE.md"), "utf8"),
		);

		const second = install("install", "claude", paths);
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("Up to date:");
		expect(install("validate", "claude", paths).status).toBe(0);
	});

	test("dry-run performs no writes", () => {
		const paths = workspace();
		const result = install("dry-run", "claude", paths);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Would link:");
		expect(() => readFileSync(join(paths.claude, "AGENTS.md"))).toThrow();
	});

	test("install migrates legacy global instruction links", () => {
		const paths = workspace();
		mkdirSync(paths.claude, { recursive: true });
		symlinkSync(join(root, "AGENTS.md"), join(paths.claude, "AGENTS.md"));
		symlinkSync(join(root, "CLAUDE.md"), join(paths.claude, "CLAUDE.md"));

		const result = install("install", "claude", paths);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Relinked:");
		expect(readlinkSync(join(paths.claude, "AGENTS.md"))).toBe(join(root, "global/AGENTS.md"));
		expect(readlinkSync(join(paths.claude, "CLAUDE.md"))).toBe(join(root, "global/CLAUDE.md"));
	});

	test("a real-file conflict prevents every planned write", () => {
		const paths = workspace();
		mkdirSync(paths.claude, { recursive: true });
		const settings = join(paths.claude, "settings.json");
		writeFileSync(settings, "user settings\n");

		const result = install("install", "claude", paths);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("leaving it untouched");
		expect(readFileSync(settings, "utf8")).toBe("user settings\n");
		expect(() => readFileSync(join(paths.claude, "AGENTS.md"))).toThrow();
	});

	test("a foreign symlink is preserved", () => {
		const paths = workspace();
		mkdirSync(paths.claude, { recursive: true });
		const foreign = join(paths.home, "foreign-settings.json");
		writeFileSync(foreign, "foreign\n");
		symlinkSync(foreign, join(paths.claude, "settings.json"));

		const result = install("install", "claude", paths);
		expect(result.status).not.toBe(0);
		expect(readFileSync(join(paths.claude, "settings.json"), "utf8")).toBe("foreign\n");
	});

	test("unlink removes only owned links and preserves userdata", () => {
		const paths = workspace();
		expect(install("install", "claude", paths).status).toBe(0);
		writeFileSync(join(paths.claude, "runtime.json"), "runtime\n");

		expect(install("unlink", "claude", paths).status).toBe(0);
		expect(readFileSync(join(paths.claude, "runtime.json"), "utf8")).toBe("runtime\n");
		expect(() => readFileSync(join(paths.claude, "AGENTS.md"))).toThrow();
	});

	test("Pi cleanup prunes stale owned extension links", () => {
		const paths = workspace();
		const extensions = join(paths.pi, "extensions");
		mkdirSync(extensions, { recursive: true });

		const stale = join(extensions, "old-extension");
		symlinkSync(join(root, "harnesses/pi/extensions/old-extension"), stale);
		const foreignTarget = join(paths.home, "foreign-extension");
		mkdirSync(foreignTarget);
		const foreign = join(extensions, "foreign-extension");
		symlinkSync(foreignTarget, foreign);

		const dryRun = install("dry-run", "pi", paths);
		expect(dryRun.status).toBe(0);
		expect(dryRun.stdout).toContain(`Would remove stale: ${stale}`);
		expect(dryRun.stdout).toContain(join(extensions, "async-questions"));
		expect(dryRun.stdout).toContain(join(extensions, "collapse-transcript"));
		expect(lstatSync(stale).isSymbolicLink()).toBe(true);

		const unlink = install("unlink", "pi", paths);
		expect(unlink.status).toBe(0);
		expect(unlink.stdout).toContain(`Unlinked stale: ${stale}`);
		expect(existsSync(stale)).toBe(false);
		expect(lstatSync(foreign).isSymbolicLink()).toBe(true);
	});

	test("Codex mutable config is seeded once and preserved", () => {
		const paths = workspace();
		expect(install("install", "codex", paths).status).toBe(0);
		const config = join(paths.codex, "config.toml");
		const baseline = Bun.TOML.parse(readFileSync(config, "utf8"));
		expect(baseline.mcp_servers).toEqual({
			linear: { url: "https://mcp.linear.app/mcp" },
		});
		writeFileSync(config, "runtime = true\n");

		expect(install("install", "codex", paths).status).toBe(0);
		expect(readFileSync(config, "utf8")).toBe("runtime = true\n");
		expect(install("unlink", "codex", paths).status).toBe(0);
		expect(readFileSync(config, "utf8")).toBe("runtime = true\n");
	});

	test("Pi MCP config is seeded once and preserves local config and auth", () => {
		const paths = workspace();
		const { checkout, environment } = piCheckout(paths.home);
		const run = (action: Parameters<typeof install>[0]) =>
			install(action, "pi", paths, environment, checkout);
		const config = join(paths.pi, "mcp.json");
		const dryRun = run("dry-run");
		expect(dryRun.status).toBe(0);
		expect(dryRun.stdout).toContain(`Would seed: ${config}`);
		expect(existsSync(config)).toBe(false);

		const first = run("install");
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(lstatSync(config).isSymbolicLink()).toBe(false);
		expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
			mcpServers: {
				linear: {
					url: "https://mcp.linear.app/mcp",
					description: "Search and manage Linear issues, projects, and documents",
					exposure: "codemode",
				},
			},
		});
		expect(existsSync(join(paths.pi, "mcp-auth.json"))).toBe(false);

		const local = '{"mcpServers":{"custom":{"url":"https://example.com/mcp"}}}\n';
		const auth = join(paths.pi, "mcp-auth.json");
		writeFileSync(config, local);
		writeFileSync(auth, "local-auth-fixture\n");
		expect(run("dry-run").stdout).toContain(`Would preserve: ${config}`);
		expect(run("install").status).toBe(0);
		expect(readFileSync(config, "utf8")).toBe(local);
		expect(readFileSync(auth, "utf8")).toBe("local-auth-fixture\n");
		expect(run("validate").status).toBe(0);
		expect(run("unlink").status).toBe(0);
		expect(readFileSync(config, "utf8")).toBe(local);
		expect(readFileSync(auth, "utf8")).toBe("local-auth-fixture\n");
	});

	test("Pi MCP symlink conflict prevents writes", () => {
		const paths = workspace();
		mkdirSync(paths.pi, { recursive: true });
		const foreign = join(paths.home, "foreign-mcp.json");
		writeFileSync(foreign, "{}\n");
		symlinkSync(foreign, join(paths.pi, "mcp.json"));

		const result = install("install", "pi", paths);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("must be absent or a regular file");
		expect(readFileSync(foreign, "utf8")).toBe("{}\n");
		expect(existsSync(join(paths.pi, "settings.json"))).toBe(false);
	});

	test("doctor requires Bun for the installed CLI", () => {
		const paths = workspace();
		const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
		const result = install("doctor", "claude", paths, {
			PATH: `${dirname(node)}:/usr/bin:/bin`,
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Missing required command: bun");
	});
});
