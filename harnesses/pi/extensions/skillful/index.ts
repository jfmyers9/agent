import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { patchDollarAutocompleteTrigger, wrapProvider } from "./autocomplete";
import { installEditorHighlight } from "./editor";
import {
	buildItems,
	collectSkills,
	formatReadSkillContent,
	isSkillfulLoadDetails,
	loadedDetails,
	rewriteSlashSkillReferences,
	SKILLFUL_CUSTOM_TYPE,
	type SkillfulLoadDetails,
	skillBaseDir,
	stripFrontmatter,
} from "./skills";
import { ensureTranscriptHighlight } from "./transcript";

const DOLLAR_RE = /(?<![\w$])\$([a-z][\w-]*)/g;
const AUTOCOMPLETE_INSTALLED = Symbol.for("skillful.autocompleteInstalled");

type SkillState = {
	skills: Map<string, string>;
	items: AutocompleteItem[];
};

type SkillLoad = {
	content: string;
	details: SkillfulLoadDetails;
};

type SkillfulTheme = {
	fg(role: string, text: string): string;
	bold(text: string): string;
};

class EmptyRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyRender = new EmptyRender();

function renderSkillLoad(details: SkillfulLoadDetails | undefined, theme: SkillfulTheme): Component {
	const name = details?.name ?? "unknown";
	const status = details?.status ?? "read";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("Skill"))} ${theme.fg("dim", "-")} ${name} ${theme.fg("muted", status)}`,
		0,
		0,
	);
}

function maskMarkdownCode(text: string): string {
	return text
		.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*(?:\n[\s\S]*?(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$))/g, (match) =>
			" ".repeat(match.length),
		)
		.replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length));
}

export default function (pi: ExtensionAPI) {
	patchDollarAutocompleteTrigger();

	const state: SkillState = { skills: new Map(), items: [] };
	const refresh = () => {
		state.skills = collectSkills(pi);
		state.items = buildItems(state.skills);
	};
	const skillNames = () => new Set(state.skills.keys());
	const currentItems = () => {
		refresh();
		return state.items;
	};
	const loadSkill = async (name: string): Promise<SkillLoad> => {
		refresh();
		const filePath = state.skills.get(name);
		if (!filePath) throw new Error(`Unknown skill "${name}"`);
		const body = rewriteSlashSkillReferences(stripFrontmatter(await readFile(filePath, "utf8")), state.skills.keys());
		const details = loadedDetails(name, "read", filePath, skillBaseDir(filePath));
		return {
			content: formatReadSkillContent(name, filePath, body),
			details,
		};
	};

	pi.on("resources_discover", () => {
		refresh();
	});

	pi.registerMessageRenderer(SKILLFUL_CUSTOM_TYPE, (message, _options, theme) => {
		const details = isSkillfulLoadDetails(message.details) ? message.details : undefined;
		return renderSkillLoad(details, theme);
	});

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: "Load a named skill by exact name.",
		promptSnippet: "Load specialized skill instructions by exact skill name",
		parameters: Type.Object({
			name: Type.String({ description: "Exact skill name" }),
		}),
		renderShell: "self",
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const load = await loadSkill(params.name);
			return {
				content: [{ type: "text", text: load.content }],
				details: load.details,
			};
		},
		renderCall(args, theme, context) {
			if (context.isPartial === false) return emptyRender;
			return renderSkillLoad(loadedDetails(args.name, "read"), theme);
		},
		renderResult(result, _options, theme) {
			const details = isSkillfulLoadDetails(result.details) ? result.details : undefined;
			if (!details) return emptyRender;
			return renderSkillLoad(details, theme);
		},
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		refresh();
		ensureTranscriptHighlight(skillNames);

		const referenced: string[] = [];
		const missing: string[] = [];
		const promptForSkillScan = maskMarkdownCode(event.prompt);
		for (const match of promptForSkillScan.matchAll(DOLLAR_RE)) {
			const name = match[1];
			if (referenced.includes(name) || missing.includes(name)) continue;
			if (state.skills.has(name)) referenced.push(name);
			else missing.push(name);
		}
		if (referenced.length === 0 && missing.length === 0) return;

		if (referenced.length === 0) {
			return {
				message: {
					customType: SKILLFUL_CUSTOM_TYPE,
					content: `Unknown skill${missing.length === 1 ? "" : "s"}: ${missing.map((name) => `$${name}`).join(", ")}`,
					display: true,
				},
			};
		}

		const loads: SkillLoad[] = [];
		for (const name of referenced) {
			loads.push(await loadSkill(name));
		}
		const [firstLoad] = loads;
		if (!firstLoad) return;
		const details =
			loads.length === 1
				? firstLoad.details
				: {
						...firstLoad.details,
						loads: loads.map((load) => load.details),
					};
		return {
			message: {
				customType: SKILLFUL_CUSTOM_TYPE,
				content: loads.map((load) => load.content).join("\n\n"),
				display: true,
				details,
			},
		};
	});

	pi.on("session_start", async (event, ctx) => {
		refresh();
		setTimeout(() => {
			try {
				refresh();
				ensureTranscriptHighlight(skillNames);
				if (ctx.hasUI) installEditorHighlight(ctx.ui, skillNames);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("ctx is stale")) throw error;
			}
		}, 0);
		if (!ctx.hasUI) return;
		const ui = ctx.ui as typeof ctx.ui & { [AUTOCOMPLETE_INSTALLED]?: true };
		if (ui[AUTOCOMPLETE_INSTALLED] && event.reason !== "reload") return;
		ui[AUTOCOMPLETE_INSTALLED] = true;
		ctx.ui.addAutocompleteProvider((current) => wrapProvider(current, currentItems));
	});
}
