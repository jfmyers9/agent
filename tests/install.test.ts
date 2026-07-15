import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
) {
	return spawnSync("bash", [join(root, "install.sh"), action, harness], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: paths.home,
			CLAUDE_CONFIG_DIR: paths.claude,
			PI_CONFIG_DIR: paths.pi,
			CODEX_CONFIG_DIR: paths.codex,
			CODEX_AGENTS_DIR: paths.agents,
			...environment,
		},
	});
}

describe("installer safety", () => {
	test("clean install is idempotent and validates", () => {
		const paths = workspace();
		const first = install("install", "claude", paths);
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(readFileSync(join(paths.claude, "AGENTS.md"), "utf8")).toBe(readFileSync(join(root, "AGENTS.md"), "utf8"));

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
		writeFileSync(config, "runtime = true\n");

		expect(install("install", "codex", paths).status).toBe(0);
		expect(readFileSync(config, "utf8")).toBe("runtime = true\n");
		expect(install("unlink", "codex", paths).status).toBe(0);
		expect(readFileSync(config, "utf8")).toBe("runtime = true\n");
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
