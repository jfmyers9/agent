import { createRequire } from "node:module";
import hljs from "highlight.js";

const WGSL_ANSI_BY_CLASS: Record<string, string> = {
	attr: "\x1b[38;5;177m",
	built_in: "\x1b[38;5;110m",
	comment: "\x1b[38;5;244m",
	keyword: "\x1b[38;5;74m",
	literal: "\x1b[38;5;151m",
	number: "\x1b[38;5;151m",
	operator: "\x1b[38;5;188m",
	punctuation: "\x1b[38;5;188m",
	type: "\x1b[38;5;79m",
};
const ANSI_FG_RESET = "\x1b[39m";

const WGSL_KEYWORDS = [
	"alias",
	"break",
	"case",
	"const",
	"const_assert",
	"continue",
	"continuing",
	"default",
	"diagnostic",
	"discard",
	"else",
	"enable",
	"fn",
	"for",
	"if",
	"let",
	"loop",
	"override",
	"requires",
	"return",
	"struct",
	"switch",
	"var",
	"while",
];

const WGSL_LITERALS = ["false", "true"];

const WGSL_TYPES = [
	"array",
	"atomic",
	"bool",
	"f16",
	"f32",
	"i32",
	"mat2x2",
	"mat2x3",
	"mat2x4",
	"mat3x2",
	"mat3x3",
	"mat3x4",
	"mat4x2",
	"mat4x3",
	"mat4x4",
	"ptr",
	"sampler",
	"sampler_comparison",
	"texture_1d",
	"texture_2d",
	"texture_2d_array",
	"texture_3d",
	"texture_cube",
	"texture_cube_array",
	"texture_depth_2d",
	"texture_depth_2d_array",
	"texture_depth_cube",
	"texture_depth_cube_array",
	"texture_depth_multisampled_2d",
	"texture_external",
	"texture_multisampled_2d",
	"texture_storage_1d",
	"texture_storage_2d",
	"texture_storage_2d_array",
	"texture_storage_3d",
	"u32",
	"vec2",
	"vec3",
	"vec4",
];

const WGSL_BUILT_INS = [
	"abs",
	"acos",
	"acosh",
	"all",
	"any",
	"arrayLength",
	"asin",
	"asinh",
	"atan",
	"atan2",
	"atanh",
	"ceil",
	"clamp",
	"cos",
	"cosh",
	"countLeadingZeros",
	"countOneBits",
	"countTrailingZeros",
	"cross",
	"degrees",
	"determinant",
	"distance",
	"dot",
	"dot4I8Packed",
	"dot4U8Packed",
	"dpdx",
	"dpdxCoarse",
	"dpdxFine",
	"dpdy",
	"dpdyCoarse",
	"dpdyFine",
	"exp",
	"exp2",
	"extractBits",
	"faceForward",
	"firstLeadingBit",
	"firstTrailingBit",
	"floor",
	"fma",
	"fract",
	"frexp",
	"insertBits",
	"inverseSqrt",
	"ldexp",
	"length",
	"log",
	"log2",
	"max",
	"min",
	"mix",
	"modf",
	"normalize",
	"pack2x16float",
	"pack2x16snorm",
	"pack2x16unorm",
	"pack4x8snorm",
	"pack4x8unorm",
	"pow",
	"quantizeToF16",
	"radians",
	"reflect",
	"refract",
	"reverseBits",
	"round",
	"saturate",
	"select",
	"sign",
	"sin",
	"sinh",
	"smoothstep",
	"sqrt",
	"step",
	"storageBarrier",
	"tan",
	"tanh",
	"textureDimensions",
	"textureGather",
	"textureGatherCompare",
	"textureLoad",
	"textureNumLayers",
	"textureNumLevels",
	"textureNumSamples",
	"textureSample",
	"textureSampleBaseClampToEdge",
	"textureSampleBias",
	"textureSampleCompare",
	"textureSampleCompareLevel",
	"textureSampleGrad",
	"textureSampleLevel",
	"textureStore",
	"transpose",
	"trunc",
	"unpack2x16float",
	"unpack2x16snorm",
	"unpack2x16unorm",
	"unpack4x8snorm",
	"unpack4x8unorm",
	"workgroupBarrier",
];

function defineWgslLanguage(api: any) {
	return {
		name: "WGSL",
		aliases: ["wgsl"],
		keywords: {
			keyword: WGSL_KEYWORDS.join(" "),
			literal: WGSL_LITERALS.join(" "),
			type: WGSL_TYPES.join(" "),
			built_in: WGSL_BUILT_INS.join(" "),
		},
		contains: [
			api.C_LINE_COMMENT_MODE,
			api.C_BLOCK_COMMENT_MODE,
			{
				className: "attr",
				begin: /@[A-Za-z_][A-Za-z0-9_]*/,
			},
			{
				className: "number",
				variants: [
					{ begin: /\b0[xX][0-9a-fA-F]+[iu]?\b/ },
					{ begin: /\b(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fh]?\b/ },
					{ begin: /\b\d+[iu]?\b/ },
				],
			},
			{
				className: "operator",
				begin: /->|[+\-*/%=!<>|&^~]+/,
			},
			{
				className: "punctuation",
				begin: /[{}()[\],;:.]/,
			},
		],
	};
}

function registerLanguage(instance: any): void {
	if (!instance?.getLanguage || !instance?.registerLanguage) return;
	if (!instance.getLanguage("wgsl")) {
		instance.registerLanguage("wgsl", defineWgslLanguage);
	}
}

function loadHighlightJsFrom(resolvedModule: string): any {
	try {
		return createRequire(resolvedModule)("highlight.js");
	} catch {
		return undefined;
	}
}

function unescapeHtml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'");
}

export function highlightWgslAnsi(code: string): string[] {
	registerLanguage(hljs);
	const html = hljs.highlight(code, { language: "wgsl", ignoreIllegals: true }).value;
	const ansi = html
		.replace(/<span class="hljs-([^"]+)">([\s\S]*?)<\/span>/g, (_match, className: string, text: string) => {
			const ansiColor = WGSL_ANSI_BY_CLASS[className];
			return ansiColor ? `${ansiColor}${text}${ANSI_FG_RESET}` : text;
		})
		.replace(/<[^>]+>/g, "");
	return unescapeHtml(ansi).split("\n");
}

export function registerWgslHighlightLanguage() {
	registerLanguage(hljs);

	const requireFromHere = createRequire(import.meta.url);
	registerLanguage(loadHighlightJsFrom(requireFromHere.resolve("cli-highlight")));

	try {
		registerLanguage(loadHighlightJsFrom(requireFromHere.resolve("@earendil-works/pi-coding-agent")));
	} catch {
		// The direct cli-highlight registration above covers test and package-local resolution.
	}
}
