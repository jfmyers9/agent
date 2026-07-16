import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { resolvePiWorkspaceDir } from "./index.js";
import { hashProjectDirCanonical } from "./session/paths.js";

const home = "/home/test-user";
const piConfigDir = join(home, ".pi");

describe("resolvePiWorkspaceDir", () => {
	it("canonicalizes relative aliases before hashing stores", () => {
		expect(hashProjectDirCanonical(".")).toBe(hashProjectDirCanonical(process.cwd()));
		expect(hashProjectDirCanonical(join(process.cwd(), "."))).toBe(hashProjectDirCanonical(process.cwd()));
	});

	it("uses workspace, project, PWD, then cwd precedence", () => {
		expect(
			resolvePiWorkspaceDir({
				env: { PI_WORKSPACE_DIR: "/work/fresh", PI_PROJECT_DIR: "/work/legacy" },
				pwd: "/work/pwd",
				cwd: "/work/cwd",
				home,
			}),
		).toBe("/work/fresh");
		expect(
			resolvePiWorkspaceDir({ env: { PI_PROJECT_DIR: "/work/project" }, pwd: "/work/pwd", cwd: "/work/cwd", home }),
		).toBe("/work/project");
		expect(resolvePiWorkspaceDir({ env: {}, pwd: "/work/pwd", cwd: "/work/cwd", home })).toBe("/work/pwd");
		expect(resolvePiWorkspaceDir({ env: {}, pwd: undefined, cwd: "/work/cwd", home })).toBe("/work/cwd");
	});

	it("rejects the Pi config directory and its descendants", () => {
		expect(
			resolvePiWorkspaceDir({
				env: { PI_WORKSPACE_DIR: join(piConfigDir, "sessions"), PI_PROJECT_DIR: "/work/safe" },
				pwd: piConfigDir,
				cwd: piConfigDir,
				home,
			}),
		).toBe("/work/safe");
		expect(
			resolvePiWorkspaceDir({
				env: { PI_WORKSPACE_DIR: piConfigDir, PI_PROJECT_DIR: join(piConfigDir, "agent") },
				pwd: piConfigDir,
				cwd: piConfigDir,
				home,
			}),
		).toBe(home);
	});
});
