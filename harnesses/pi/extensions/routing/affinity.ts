import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ASSESSMENT_ENTRY = "routing:assessment-v1";
export interface AssessmentRequest {
	version: 1;
	id: string;
	mode: "reassess" | "reset";
}

/** The latest explicit request wins; consumed IDs travel with native branch-local route state. */
export function pendingAssessment(
	ctx: Pick<ExtensionContext, "sessionManager">,
	state?: { assessmentId?: string },
): AssessmentRequest | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== ASSESSMENT_ENTRY) continue;
		const data = entry.data as Partial<AssessmentRequest> | undefined;
		if (
			data?.version !== 1 ||
			typeof data.id !== "string" ||
			!data.id ||
			(data.mode !== "reassess" && data.mode !== "reset")
		)
			continue;
		return data.id === state?.assessmentId ? undefined : (data as AssessmentRequest);
	}
	return undefined;
}
