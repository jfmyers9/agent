import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");

function workspace() {
	const home = mkdtempSync(join(tmpdir(), "agent-install-"));
	return {
		home,
		claude: join(home, "claude config"),
		codex: join(home, "codex config"),
		agents: join(home, "agents config"),
	};
}

function install(
	action: "install" | "dry-run" | "validate" | "unlink",
	harness: "claude" | "codex",
	paths: ReturnType<typeof workspace>,
) {
	return spawnSync("bash", [join(root, "install.sh"), action, harness], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: paths.home,
			CLAUDE_CONFIG_DIR: paths.claude,
			CODEX_CONFIG_DIR: paths.codex,
			CODEX_AGENTS_DIR: paths.agents,
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
});
