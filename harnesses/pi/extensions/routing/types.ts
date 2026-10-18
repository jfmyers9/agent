import type { Usage } from "@earendil-works/pi-ai";

export interface ModelRef {
	provider: string;
	id: string;
}

export type Tier = "luna" | "sol" | "astra";

export interface ActiveWorkBrief {
	objective: string;
	constraints: string[];
	remaining: string[];
}

export interface TaskEnvelope {
	task: string;
	/** The current task or explicitly supplied scope was clipped, not merely old history. */
	truncated?: boolean;
	/** Deliberate omission of older conversation is not itself an incomplete task. */
	historyOmitted?: boolean;
	activeWork?: ActiveWorkBrief;
	context?: string;
	recentHistory?: string;
	knownScope?: string[];
	uncertainties?: string[];
	expectedOutput?: string;
}

export interface Classification {
	tier: Tier;
	reason: string;
	insufficient_context: boolean;
	active_work: ActiveWorkBrief;
}

export interface ClassifierResult extends Omit<Classification, "active_work"> {
	/** Missing only when no usable assessment was produced. */
	active_work?: ActiveWorkBrief;
	/** Raw recommendation before applying the conservative Sol floor. */
	recommendedTier?: Tier;
	latencyMs: number;
	/** Transport/protocol failure, not ordinary uncertainty about task scope. */
	fallback?: string;
}

export interface ClassifierUsage {
	/** Physical request target; responseModel records a differing provider-reported identity. */
	provider: string;
	model: string;
	responseModel?: string;
	usage: Usage;
}
