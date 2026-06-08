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
	return "unknown";
})();

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export function trackResponse(toolName: string, response: ToolResult): ToolResult {
	const bytes = response.content.reduce((sum, c) => sum + Buffer.byteLength(c.text), 0);
	setImmediate(() =>
		sessionRecordToolTelemetry({
			sessionDbPath: getSessionDbPath(),
			projectDir: getProjectDir(),
			toolName,
			bytesReturned: bytes,
		}),
	);

	return response;
}

export function trackIndexed(bytes: number, source: string = "unknown"): void {
	if (bytes > 0) {
		setImmediate(() =>
			sessionRecordToolTelemetry({
				sessionDbPath: getSessionDbPath(),
				projectDir: getProjectDir(),
				toolName: "cg_index",
				source,
				bytesAvoided: bytes,
			}),
		);
	}
}
