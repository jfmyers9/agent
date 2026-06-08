import type { AskParams } from "../types";
import { normalizeQuestions } from "./normalize";
import { createInitialState as createBaseState } from "./transitions";

export function createInitialState(params: AskParams) {
	return createBaseState({
		title: params.title,
		questions: normalizeQuestions(params),
	});
}
