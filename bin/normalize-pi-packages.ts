import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const canonical = require.resolve("@luan.sh/pi-code-mode/sdk");

// Bun overrides resolve the dependency graph, but npm tarballs still contain
// bundled copies. Those copies shadow the patched root package at runtime.
for (const name of ["pi-subagents", "pi-tool-search"]) {
	const packageDir = join(root, "node_modules", "@luan.sh", name);
	await rm(join(packageDir, "node_modules", "@luan.sh", "pi-code-mode"), { recursive: true, force: true });
	const consumer = createRequire(join(packageDir, "package.json"));
	if (consumer.resolve("@luan.sh/pi-code-mode/sdk") !== canonical) {
		throw new Error(`${name} did not resolve the patched Code Mode dependency`);
	}
}
