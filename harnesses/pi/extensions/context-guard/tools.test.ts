import { describe, expect, it } from "bun:test";
import { registerPiContextTools } from "./pi/tools.js";

describe("context-guard tool registration", () => {
	it("exposes cg_fetch URL inputs to the model", () => {
		const tools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
		registerPiContextTools({
			registerTool: (tool) => tools.push(tool),
		});

		const fetch = tools.find((tool) => tool.name === "cg_fetch");
		expect(fetch?.parameters).toMatchObject({
			type: "object",
			properties: {
				url: { type: "string" },
				requests: {
					type: "array",
					items: {
						type: "object",
						properties: { url: { type: "string" } },
					},
				},
			},
		});
	});
});
