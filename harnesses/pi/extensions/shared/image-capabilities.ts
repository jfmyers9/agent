import * as childProcess from "node:child_process";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";

type NativeImageProtocol = "kitty" | "iterm2";

let configured = false;
let tmuxClientTermCache: string | null | undefined;

function isTmuxSession(): boolean {
	return !!process.env.TMUX || /^(tmux|screen)/.test(process.env.TERM ?? "");
}

function normalizeTerminalName(term: string): string {
	const t = term.toLowerCase();
	if (t.includes("kitty")) return "kitty";
	if (t.includes("ghostty")) return "ghostty";
	if (t.includes("wezterm")) return "WezTerm";
	if (t.includes("iterm")) return "iTerm.app";
	if (t.includes("mintty")) return "mintty";
	return term;
}

function readTmuxClientTerm(): string | null {
	if (!isTmuxSession()) return null;
	if (tmuxClientTermCache !== undefined) return tmuxClientTermCache;
	try {
		const term = childProcess
			.execFileSync("tmux", ["display-message", "-p", "#{client_termname}"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 200,
			})
			.trim();
		tmuxClientTermCache = term ? normalizeTerminalName(term) : null;
	} catch {
		tmuxClientTermCache = null;
	}
	return tmuxClientTermCache;
}

function detectImageProtocol(): NativeImageProtocol | null {
	const forced = (process.env.PI_IMAGE_PROTOCOL ?? process.env.PRETTY_IMAGE_PROTOCOL ?? "").toLowerCase();
	if (forced === "kitty" || forced === "iterm2") return forced;
	if (forced === "none") return null;

	if (process.env.LC_TERMINAL === "iTerm2") return "iterm2";
	if (process.env.GHOSTTY_RESOURCES_DIR || process.env.KITTY_WINDOW_ID || process.env.KITTY_PID) return "kitty";
	if (process.env.WEZTERM_EXECUTABLE || process.env.WEZTERM_CONFIG_DIR || process.env.WEZTERM_CONFIG_FILE) {
		return "kitty";
	}

	const termProgram = process.env.TERM_PROGRAM ?? "";
	const term =
		termProgram && termProgram !== "tmux" && termProgram !== "screen"
			? normalizeTerminalName(termProgram)
			: (readTmuxClientTerm() ?? normalizeTerminalName(process.env.TERM ?? ""));
	if (term === "ghostty" || term === "kitty" || term === "WezTerm") return "kitty";
	if (term === "iTerm.app" || term === "mintty") return "iterm2";
	return null;
}

export function configureImageCapabilities(): void {
	if (configured) return;
	configured = true;

	const capabilities = getCapabilities();
	if (capabilities.images) return;
	if (isTmuxSession()) return;

	const protocol = detectImageProtocol();
	if (!protocol) return;

	setCapabilities({
		...capabilities,
		images: protocol,
		trueColor: capabilities.trueColor || process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit",
	});
}
