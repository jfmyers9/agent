import { basename, extname } from "node:path";

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { BundledLanguage } from "shiki";

const PATH_LANGUAGE_CANDIDATES: Record<string, string[]> = {
	".env": ["dotenv"],
	".envrc": ["bash"],
	containerfile: ["dockerfile"],
	dockerfile: ["dockerfile"],
	gnumakefile: ["makefile"],
	makefile: ["makefile"],
};

const INLINE_LANGUAGE_FALLBACKS: Record<string, string> = {
	astro: "html",
	erb: "html",
	handlebars: "html",
	hbs: "html",
	mdx: "markdown",
	svelte: "html",
	vue: "html",
};

const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
	cjs: "javascript",
	cc: "cpp",
	cxx: "cpp",
	h: "c",
	hpp: "cpp",
	js: "javascript",
	jsx: "jsx",
	kts: "kotlin",
	md: "markdown",
	mjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	ts: "typescript",
	tsx: "tsx",
	yml: "yaml",
	zsh: "bash",
};

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

function fileExtension(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const extension = extname(path).slice(1).toLowerCase();
	return extension || undefined;
}

export function pathLanguageCandidates(path: string | undefined): string[] {
	if (!path) return [];
	const normalizedPath = normalizePath(path);
	const base = basename(normalizedPath).toLowerCase();
	const extension = fileExtension(normalizedPath);
	let detected: string | undefined;
	try {
		detected = getLanguageFromPath(normalizedPath)?.toLowerCase();
	} catch {
		// Fall through to filename- and extension-based matching below.
	}
	return [
		...(PATH_LANGUAGE_CANDIDATES[base] ?? []),
		extension,
		base.startsWith(".") ? base.slice(1) : undefined,
		detected,
	].filter(
		(candidate, index, candidates): candidate is string => !!candidate && candidates.indexOf(candidate) === index,
	);
}

export function resolveShikiLanguageForPath(path: string | undefined): BundledLanguage | undefined {
	const language = pathLanguageCandidates(path)
		.map((candidate) => SHIKI_LANGUAGE_ALIASES[candidate] ?? candidate)
		.find(Boolean);
	return language as BundledLanguage | undefined;
}

export function resolveInlineLanguageForPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		const detected = getLanguageFromPath(path);
		if (detected) return detected;
	} catch {
		// Fall through to Shiki-derived fallback below.
	}
	const shikiLanguage = resolveShikiLanguageForPath(path);
	if (!shikiLanguage) return undefined;
	return INLINE_LANGUAGE_FALLBACKS[shikiLanguage] ?? shikiLanguage;
}
