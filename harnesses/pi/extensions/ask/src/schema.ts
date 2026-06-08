import { Type } from "typebox";

export const AskOptionSchema = Type.Object({
	value: Type.Optional(
		Type.String({
			description: "Required answer key",
		}),
	),
	label: Type.Optional(
		Type.String({
			description: "Required visible label",
		}),
	),
	description: Type.Optional(
		Type.String({
			description: "Optional hint",
		}),
	),
	preview: Type.Optional(
		Type.String({
			description: "Required for preview questions",
		}),
	),
});

export const AskQuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			description: "Answer key",
		}),
	),
	label: Type.Optional(
		Type.String({
			description: "Short tab label",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description: "Direct question",
		}),
	),
	type: Type.Optional(
		Type.String({
			description: "single (default), multi, or preview; preview needs option.preview",
		}),
	),
	required: Type.Optional(
		Type.Boolean({
			description: "Advisory only",
		}),
	),
	options: Type.Array(AskOptionSchema, {
		description: "2-4 options preferred; every option needs value+label",
	}),
});

export const AskParamsSchema = Type.Object({
	title: Type.Optional(
		Type.String({
			description: "Optional flow title",
		}),
	),
	questions: Type.Array(AskQuestionSchema, {
		description: "1-3 focused questions",
	}),
});
