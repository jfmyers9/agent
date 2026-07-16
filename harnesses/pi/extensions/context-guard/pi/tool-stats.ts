import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionRecordToolTelemetry } from "../session/core-session.js";
import { getProjectDir, getSessionDbPath } from "./tool-paths.js";

const pkgDir = dirname(fileURLToPath(import.meta.url));
export const VERSION: string = (() => {
	for (const rel of ["../../package.json", "../package.json", "./package.json"]) {
		const p = resolve(pkgDir, rel);
		if (existsSync(p)) {
			try {
				return JSON.parse(readFileSync(p, "utf8")).version;
			} catch {}
		}
	}
	const cargoToml = resolve(pkgDir, "../../../../../crates/context-guard/Cargo.toml");
	if (existsSync(cargoToml)) {
		try {
			const match = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(cargoToml, "utf8"));
			if (match?.[1]) return match[1];
		} catch {}
	}
	return "unknown";
})();

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export function trackResponse(
	toolName: string,
	response: ToolResult,
	indexed?: { bytes: number; source?: string },
): ToolResult {
	const bytes = response.content.reduce((sum, c) => sum + Buffer.byteLength(c.text), 0);
	setImmediate(() => {
		void sessionRecordToolTelemetry({
			sessionDbPath: getSessionDbPath(),
			projectDir: getProjectDir(),
			toolName,
			bytesReturned: bytes,
			bytesAvoided: indexed?.bytes,
			source: indexed?.source,
		});
	});

	return response;
}
