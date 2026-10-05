import { expect, test } from "bun:test";
import { zstdDecompressSync } from "node:zlib";
import fastMode, { FAST_MODE_ENTRY, FAST_MODE_STATUS, fastRoute } from "./fast-mode";

const openai = { provider: "openai", api: "openai-responses", id: "gpt-5.4", baseUrl: "https://api.openai.com/v1" };
const codex = {
	...openai,
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};
function harness(model: any = openai) {
	const handlers: Record<string, (...args: any[]) => any> = {};
	const entries: any[] = [];
	const notices: string[] = [];
	const statuses = new Map<string, string>();
	let command: any;
	let shortcut: any;
	fastMode({
		on: (name: string, handler: any) => {
			handlers[name] = handler;
		},
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, def: any) => {
			expect(name).toBe("fast");
			command = def;
		},
		registerShortcut: (key: string, def: any) => {
			expect(key).toBe("alt+g");
			shortcut = def;
		},
	} as never);
	const ctx = {
		model,
		hasUI: true,
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus: (key: string, value: string | undefined) => {
				if (value) statuses.set(key, value);
				else statuses.delete(key);
			},
			notify: (text: string) => notices.push(text),
		},
	};
	return { handlers, entries, notices, statuses, command, shortcut, ctx };
}

test("only first-party GPT Responses routes are eligible", () => {
	expect(fastRoute(openai)).toBe("openai");
	expect(fastRoute(codex)).toBe("codex");
	for (const model of [
		undefined,
		{ ...openai, provider: "openrouter" },
		{ ...openai, baseUrl: "https://proxy.example.com/v1" },
		{ ...openai, baseUrl: "http://api.openai.com/v1" },
		{ ...openai, baseUrl: "https://api.openai.com.example.com/v1" },
		{ ...openai, baseUrl: "invalid" },
		{ ...openai, id: "claude-example" },
		{ ...openai, api: "openai-completions" },
	])
		expect(fastRoute(model)).toBeUndefined();
});

test("defaults on and preserves payload fields without mutating caller input", () => {
	const f = harness();
	f.handlers.session_start({}, f.ctx);
	expect(f.statuses.get(FAST_MODE_STATUS)).toBe("fast");
	const payload = { model: openai.id, input: [], reasoning: { effort: "high" }, service_tier: "auto" };
	expect(f.handlers.before_provider_request({ payload }, f.ctx)).toEqual({ ...payload, service_tier: "priority" });
	expect(payload.service_tier).toBe("auto");
	const headers = { authorization: "fixture", originator: "pi" };
	expect(f.handlers.before_provider_headers).toBeUndefined();
	expect(headers).toEqual({ authorization: "fixture", originator: "pi" });
	for (const invalid of [null, [], "text", { model: "other-model" }])
		expect(f.handlers.before_provider_request({ payload: invalid }, f.ctx)).toBeUndefined();
});

test("Codex uses body priority without overriding authentication or originator headers", async () => {
	const f = harness(codex);
	expect(f.handlers.before_provider_request({ payload: { model: codex.id } }, f.ctx)).toEqual({
		model: codex.id,
		service_tier: "priority",
	});
	expect(f.handlers.before_provider_headers).toBeUndefined();
	await f.command.handler("off", f.ctx);
	expect(f.handlers.before_provider_request({ payload: { model: codex.id } }, f.ctx)).toBeUndefined();
});
test("toggle persists on the session branch, reload restores it, new sessions default on", async () => {
	const f = harness();
	await f.shortcut.handler(f.ctx);
	expect(f.entries).toEqual([{ type: "custom", customType: FAST_MODE_ENTRY, data: { enabled: false } }]);
	f.handlers.session_start({}, f.ctx);
	expect(f.statuses.has(FAST_MODE_STATUS)).toBe(false);
	expect(f.handlers.before_provider_request({ payload: { model: openai.id } }, f.ctx)).toBeUndefined();
	f.entries.length = 0;
	f.handlers.session_tree({}, f.ctx);
	expect(f.statuses.get(FAST_MODE_STATUS)).toBe("fast");
	f.handlers.session_shutdown({}, f.ctx);
	expect(f.statuses.has(FAST_MODE_STATUS)).toBe(false);
	f.handlers.session_start({}, f.ctx);
	expect(f.statuses.get(FAST_MODE_STATUS)).toBe("fast");
});

test("model changes suspend priority, status and invalid commands are non-mutating", async () => {
	const f = harness();
	f.ctx.model = { ...openai, provider: "other" };
	f.handlers.model_select({}, f.ctx);
	expect(f.statuses.has(FAST_MODE_STATUS)).toBe(false);
	expect(f.handlers.before_provider_request({ payload: { model: openai.id } }, f.ctx)).toBeUndefined();
	await f.command.handler("on", f.ctx);
	expect(f.entries).toHaveLength(0);
	await f.command.handler("", f.ctx);
	expect(f.notices.at(-1)).toContain("inactive");
	await f.command.handler("invalid", f.ctx);
	expect(f.notices.at(-1)).toContain("Usage");
	f.ctx.model = openai;
	f.handlers.model_select({}, f.ctx);
	expect(f.statuses.get(FAST_MODE_STATUS)).toBe("fast");
	f.ctx.hasUI = false;
	expect(f.handlers.before_provider_request({ payload: { model: openai.id } }, f.ctx)?.service_tier).toBe("priority");
});

test("native OpenAI and Codex adapters transmit priority with mocked HTTP, without changing reasoning", async () => {
	for (const provider of ["openai", "openai-codex"] as const) {
		const model = {
			...(provider === "openai" ? openai : codex),
			name: "GPT fixture",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const f = harness(model);
		const modulePath = new URL(`./api/${model.api}.js`, import.meta.resolve("@earendil-works/pi-ai")).href;
		const { stream } = await import(modulePath);
		let body: any;
		const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
		const response = {
			type: "response.completed",
			response: {
				id: "fixture",
				status: "completed",
				service_tier: "priority",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		};
		const output = stream(
			model,
			{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
			{
				apiKey: provider === "openai" ? "sk-fixture" : token,
				transport: "sse",
				maxRetries: 0,
				reasoningEffort: "high",
				onPayload: (payload: unknown) => f.handlers.before_provider_request({ payload }, f.ctx),
				fetch: async (_url: unknown, init: RequestInit) => {
					const request = new Request(_url as Request, init);
					const bytes = Buffer.from(await request.arrayBuffer());
					body = JSON.parse(
						(request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString(),
					);
					return new Response(`event: response.completed\ndata: ${JSON.stringify(response)}\n\n`, {
						headers: { "Content-Type": "text/event-stream" },
					});
				},
			},
		);
		const result = await output.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).not.toBe("error");
		expect(body.service_tier).toBe("priority");
		expect(body.reasoning.effort).toBe("high");
		expect(body.model).toBe(model.id);
	}
});
