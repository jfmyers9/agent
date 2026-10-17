import type { Usage } from "@earendil-works/pi-ai";

export interface ModelRef {
	provider: string;
	id: string;
}

export type Tier = "luna" | "sol" | "astra";

export interface TaskEnvelope {
	task: string;
	context?: string;
	knownScope?: string[];
	uncertainties?: string[];
	expectedOutput?: string;
}

export interface Classification {
	tier: Tier;
	reason: string;
	insufficient_context: boolean;
}

export interface ClassifierResult extends Classification {
	latencyMs: number;
	fallback?: string;
}

export interface ClassifierUsage {
	/** Physical request target; responseModel records a differing provider-reported identity. */
	provider: string;
	model: string;
	responseModel?: string;
	usage: Usage;
}
