import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER = "fireworks-gateway";

function gatewayUrl(): string | undefined {
	const envUrl = process.env.PI_FIREWORKS_GATEWAY_URL;
	if (envUrl) {
		try {
			const url = new URL(envUrl);
			if (url.protocol === "https:") return url.href.replace(/\/$/, "");
		} catch {
			// Fall through to the optional local configuration.
		}
	}
	try {
		const config = JSON.parse(readFileSync(join(getAgentDir(), "fireworks-gateway.json"), "utf8")) as {
			baseUrl?: unknown;
		};
		if (typeof config.baseUrl !== "string") return undefined;
		const url = new URL(config.baseUrl);
		return url.protocol === "https:" ? url.href.replace(/\/$/, "") : undefined;
	} catch {
		return undefined;
	}
}

export default function fireworksGateway(pi: ExtensionAPI) {
	const baseUrl = gatewayUrl();
	if (!baseUrl) return;

	pi.registerProvider(PROVIDER, {
		baseUrl,
		api: "openai-completions",
		// Pi requires a configured key to list models. This key is never sent.
		apiKey: "unused",
		models: [
			{
				id: "accounts/fireworks/models/deepseek-v4p1-flash",
				name: "DeepSeek V4.1 Flash",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" },
				input: ["text", "image"],
				contextWindow: 1_048_576,
				maxTokens: 16_384,
				cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
				compat: { supportsStore: false, supportsDeveloperRole: false },
			},
			{
				id: "accounts/fireworks/models/glm-5p3-flash",
				name: "GLM 5.3 Flash",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "high", high: "high", xhigh: "max" },
				input: ["text", "image"],
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
				compat: { supportsStore: false, supportsDeveloperRole: false },
			},
			{
				id: "accounts/fireworks/models/kimi-k3",
				name: "Kimi K3",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
				input: ["text", "image"],
				contextWindow: 1_064_960,
				maxTokens: 32_000,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					requiresReasoningContentOnAssistantMessages: true,
					thinkingFormat: "openai",
				},
			},
		],
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.provider === PROVIDER) event.headers.Authorization = null;
	});
}
