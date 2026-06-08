import type { AskOption, AskParams, AskQuestion, AskQuestionInput, AskValidationIssue } from "../types";

interface IssueCollector {
	add: (path: string, message: string) => void;
	issues: AskValidationIssue[];
}

export function normalizeQuestions(params: AskParams): AskQuestion[] {
	const issues = collectValidationIssues(params);
	if (issues.length > 0) {
		throw new Error(issues[0]?.message ?? "Invalid ask_user payload");
	}
	return params.questions.map(normalizeQuestion);
}

export function collectValidationIssues(params: AskParams): AskValidationIssue[] {
	const collector = createIssueCollector();
	validateQuestions(params.questions, collector);
	return collector.issues;
}

function normalizeQuestion(question: AskQuestionInput, index: number): AskQuestion {
	return {
		id: question.id.trim(),
		label: question.label?.trim() || `Q${index + 1}`,
		prompt: question.prompt.trim(),
		type: normalizeQuestionType(question.type),
		required: question.required ?? false,
		options: question.options.map(normalizeOption),
	};
}

function normalizeOption(option: AskOption): AskOption {
	return {
		value: option.value.trim(),
		label: option.label.trim(),
		description: option.description?.trim(),
		preview: option.preview?.trim(),
	};
}

function validateQuestions(questions: AskParams["questions"], collector: IssueCollector) {
	if (questions.length === 0) {
		collector.add("questions", "At least one question is required");
		return;
	}

	const questionIds = new Set<string>();
	for (const [questionIndex, question] of questions.entries()) {
		validateQuestion(question, questionIndex, questionIds, collector);
	}
}

function validateQuestion(
	question: AskQuestionInput,
	questionIndex: number,
	questionIds: Set<string>,
	collector: IssueCollector,
) {
	const questionNumber = questionIndex + 1;
	const questionPath = `questions[${questionIndex}]`;
	const questionId = question.id?.trim();
	const questionType = normalizeQuestionType(question.type);

	validateQuestionType(question.type, questionNumber, collector, `${questionPath}.type`);
	assertRequired(questionId, collector, `${questionPath}.id`, `Question ${questionNumber}: id is required`);
	assertUnique(
		questionIds,
		questionId,
		collector,
		`${questionPath}.id`,
		`Question ${questionNumber}: duplicate question id "${questionId}"`,
	);
	assertOptionalText(
		question.label,
		collector,
		`${questionPath}.label`,
		`Question ${questionNumber}: label must not be empty`,
	);
	assertRequired(
		question.prompt?.trim(),
		collector,
		`${questionPath}.prompt`,
		`Question ${questionNumber}: prompt is required`,
	);
	assertHasItems(
		question.options,
		collector,
		`${questionPath}.options`,
		`Question ${questionNumber}: at least one option is required`,
	);

	const optionValues = new Set<string>();
	for (const [optionIndex, option] of question.options.entries()) {
		validateOption(
			option,
			optionIndex,
			optionValues,
			questionNumber,
			questionType,
			collector,
			`${questionPath}.options[${optionIndex}]`,
		);
	}
}

function validateOption(
	option: AskOption,
	optionIndex: number,
	optionValues: Set<string>,
	questionNumber: number,
	questionType: AskQuestion["type"],
	collector: IssueCollector,
	optionPath: string,
) {
	const optionNumber = optionIndex + 1;
	const prefix = `Question ${questionNumber}, option ${optionNumber}`;
	const optionValue = option.value?.trim();
	const optionPreview = option.preview?.trim();

	assertRequired(optionValue, collector, `${optionPath}.value`, `${prefix}: value is required`);
	assertUnique(
		optionValues,
		optionValue,
		collector,
		`${optionPath}.value`,
		`${prefix}: duplicate option value "${optionValue}"`,
	);
	assertRequired(option.label?.trim(), collector, `${optionPath}.label`, `${prefix}: label is required`);
	assertOptionalText(
		option.description,
		collector,
		`${optionPath}.description`,
		`${prefix}: description must not be empty`,
	);
	assertOptionalText(option.preview, collector, `${optionPath}.preview`, `${prefix}: preview must not be empty`);
	if (questionType === "preview") {
		assertRequired(
			optionPreview,
			collector,
			`${optionPath}.preview`,
			`${prefix}: preview questions require preview text for every option; add preview text or use type "single" instead`,
		);
	}
}

function normalizeQuestionType(value: AskQuestionInput["type"]): AskQuestion["type"] {
	return value === "multi" || value === "preview" ? value : "single";
}

function validateQuestionType(
	value: AskQuestionInput["type"],
	questionNumber: number,
	collector: IssueCollector,
	path: string,
) {
	if (value !== undefined && value !== "single" && value !== "multi" && value !== "preview") {
		collector.add(
			path,
			`Question ${questionNumber}: invalid type ${JSON.stringify(value)}; expected "single", "multi", or "preview"`,
		);
	}
}

function assertHasItems(items: unknown[], collector: IssueCollector, path: string, message: string) {
	if (items.length === 0) {
		collector.add(path, message);
	}
}

function assertRequired(value: string | undefined, collector: IssueCollector, path: string, message: string) {
	if (!value) {
		collector.add(path, message);
	}
}

function assertOptionalText(value: string | undefined, collector: IssueCollector, path: string, message: string) {
	if (value !== undefined && !value.trim()) {
		collector.add(path, message);
	}
}

function assertUnique(
	seen: Set<string>,
	value: string | undefined,
	collector: IssueCollector,
	path: string,
	message: string,
) {
	if (!value) {
		return;
	}
	if (seen.has(value)) {
		collector.add(path, message);
		return;
	}
	seen.add(value);
}

function createIssueCollector(): IssueCollector {
	const issues: AskValidationIssue[] = [];
	return {
		issues,
		add(path, message) {
			issues.push({ path, message });
		},
	};
}
