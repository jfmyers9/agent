import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type ClipboardMirrorPolicy = "all" | "yank" | "never";
export type RegisterWriteSource = "mutation" | "yank";

export const DEFAULT_CLIPBOARD_MIRROR_POLICY: ClipboardMirrorPolicy = "all";

export type PiVimSettings = { clipboardMirror?: unknown };

type UnknownRecord = Record<string, unknown>;

const missing = Symbol();

function formatInvalid(value: unknown) {
	const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	try {
		return `${JSON.stringify(value) ?? type} (type ${type})`;
	} catch {
		return `(type ${type})`;
	}
}

function readSetting(settings: unknown): unknown {
	if (typeof settings !== "object" || settings === null || !Object.hasOwn(settings, "piVim")) return missing;
	const piVim = (settings as UnknownRecord).piVim;
	if (typeof piVim !== "object" || piVim === null || Array.isArray(piVim)) return piVim;
	return Object.hasOwn(piVim, "clipboardMirror") ? (piVim as UnknownRecord).clipboardMirror : missing;
}

export function resolveClipboardMirrorPolicy(value: unknown) {
	if (value === undefined) return { policy: DEFAULT_CLIPBOARD_MIRROR_POLICY };

	if (typeof value === "string") {
		const policy = value.trim().toLowerCase();
		if (policy === "all" || policy === "yank" || policy === "never") {
			return { policy: policy as ClipboardMirrorPolicy };
		}
	}

	return {
		policy: DEFAULT_CLIPBOARD_MIRROR_POLICY,
		warning: `Invalid piVim.clipboardMirror ${formatInvalid(value)}; expected all, yank, never. Using all.`,
	};
}

export function readPiVimClipboardMirrorSetting(
	globalSettings: unknown,
	projectSettings: unknown,
): unknown | undefined {
	const project = readSetting(projectSettings);
	if (project !== missing) return project;
	const global = readSetting(globalSettings);
	return global === missing ? undefined : global;
}

function readPiVimSettingsFromDisk(cwd: string): PiVimSettings {
	const settings = SettingsManager.create(cwd);
	return {
		clipboardMirror: readPiVimClipboardMirrorSetting(settings.getGlobalSettings(), settings.getProjectSettings()),
	};
}

let piVimSettingsReader = readPiVimSettingsFromDisk;

export function readPiVimSettings(cwd: string) {
	return piVimSettingsReader(cwd);
}

export function setPiVimSettingsReaderForTests(reader: typeof readPiVimSettingsFromDisk) {
	const prev = piVimSettingsReader;
	piVimSettingsReader = reader;

	return () => {
		piVimSettingsReader = prev;
	};
}
