import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fileopsExtension from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createHarness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	fileopsExtension({
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
	} as any);
	return { tools, commands };
}

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};

function renderText(component: { render(width: number): string[] }): string {
	return component.render(120).join("\n");
}

describe("fileops read rendering", () => {
	it("shows large-read guidance in collapsed read results", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fileops-large-read-"));
		tempDirs.push(dir);
		await writeFile(join(dir, "large.rs"), "let value = 1;\n".repeat(4000));
		const { tools } = createHarness();

		const result = await tools
			.get("read")
			.execute("read-large", { path: "large.rs" }, undefined, undefined, { cwd: dir });
		const rendered = renderText(tools.get("read").renderResult(result, { expanded: false }, theme));

		expect(result.details?.protected).toBe(true);
		expect(rendered).toContain("Large file read blocked: large.rs");
		expect(rendered).toContain("Use bounded read arguments");
		expect(rendered).toContain("cg_process_file");
	});

	it("keeps ordinary hashline reads hidden when collapsed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fileops-small-read-"));
		tempDirs.push(dir);
		await writeFile(join(dir, "small.rs"), "fn main() {}\n");
		const { tools } = createHarness();

		const result = await tools.get("read").execute("read-small", { path: "small.rs" }, undefined, undefined, { cwd: dir });
		const rendered = tools.get("read").renderResult(result, { expanded: false }, theme).render(120);

		expect(result.content[0]?.text).toStartWith("¶small.rs#");
		expect(rendered).toEqual([]);
	});
});
