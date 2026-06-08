import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExecResultLike = {
	code: number;
	stdout?: string;
	stderr?: string;
};

type RtkResolution = {
	command: string;
	resolver: "which" | "where";
	resolvedPath?: string;
	warning?: string;
};

export type RtkRewriteDecision = {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	reason: "disabled" | "empty" | "already_rtk" | "no_match" | "ok";
	usedRtk?: boolean;
	warning?: string;
};

export interface RtkWrapperState {
	enabled: boolean;
}

type ShellTokenSpan = {
	value: string;
	start: number;
	end: number;
};

const RTK_REWRITE_TIMEOUT_MS = 3000;
const RTK_RESOLVE_TIMEOUT_MS = 1000;

function isExecResultLike(value: unknown): value is ExecResultLike {
	return typeof value === "object" && value !== null && "code" in value && typeof value.code === "number";
}

function trimDetail(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(value: string): string {
	const first = value[0];
	const last = value[value.length - 1];
	if (value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
		return value.slice(1, -1);
	}
	return value;
}

export function parseRtkExecutablePath(stdout: string): string | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		const candidate = stripWrappingQuotes(line.trim());
		if (candidate) return candidate;
	}
	return undefined;
}

async function resolveRtkExecutable(pi: ExtensionAPI): Promise<RtkResolution> {
	const resolver: "which" | "where" = process.platform === "win32" ? "where" : "which";
	try {
		const result = await pi.exec(resolver, ["rtk"], { timeout: RTK_RESOLVE_TIMEOUT_MS });
		const resolvedPath = parseRtkExecutablePath(result.stdout ?? "");
		if (result.code === 0 && resolvedPath) {
			return { command: resolvedPath, resolver, resolvedPath };
		}
		const detail = trimDetail(result.stderr || result.stdout || `exit ${result.code}`);
		return {
			command: "rtk",
			resolver,
			warning: `rtk executable path resolution via ${resolver} failed${detail ? `: ${detail}` : ""}`,
		};
	} catch (error) {
		return {
			command: "rtk",
			resolver,
			warning: `rtk executable path resolution via ${resolver} failed: ${trimDetail(
				error instanceof Error ? error.message : String(error),
			)}`,
		};
	}
}

function isAlreadyRtk(command: string): boolean {
	const trimmed = command.trimStart();
	return trimmed === "rtk" || trimmed.startsWith("rtk ");
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function commandIndex(tokens: string[]): number | undefined {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token || isEnvAssignment(token) || token === "command" || token === "builtin" || token === "noglob") {
			continue;
		}
		if (token === "env") continue;
		return index;
	}
	return undefined;
}

function commandName(token: string): string {
	return token.replace(/\\/g, "/").split("/").pop() ?? token;
}

function isGitCommandName(name: string): boolean {
	return name === "git";
}

function isRtkGitSegment(segment: string[]): boolean {
	const index = commandIndex(segment);
	if (index === undefined) return false;
	const executable = commandName(segment[index] ?? "");
	return executable === "rtk" && segment[index + 1] === "git";
}

function isGitSegment(segment: string[]): boolean {
	const index = commandIndex(segment);
	if (index === undefined) return false;
	return isGitCommandName(commandName(segment[index] ?? ""));
}

function isGitFamilySegment(segment: string[]): boolean {
	const index = commandIndex(segment);
	if (index === undefined) return false;
	const executable = commandName(segment[index] ?? "");
	return executable === "git" || executable === "gt" || executable === "gh" || isRtkGitSegment(segment);
}

function ripgrepCommandIndex(tokens: string[]): number | undefined {
	const index = commandIndex(tokens);
	if (index === undefined) return undefined;
	const name = commandName(tokens[index] ?? "");
	return name === "rg" || name === "ripgrep" ? index : undefined;
}

function pushToken(tokens: ShellTokenSpan[], value: string, start: number | undefined, end: number): void {
	if (value.length === 0 || start === undefined) return;
	tokens.push({ value, start, end });
}

function shellSplitWithSpans(input: string): ShellTokenSpan[] {
	const tokens: ShellTokenSpan[] = [];
	let current = "";
	let tokenStart: number | undefined;
	let tokenEnd = 0;
	let quote: "'" | '"' | undefined;
	let escaping = false;

	const beginToken = (index: number) => {
		tokenStart ??= index;
	};
	const flushCurrent = () => {
		pushToken(tokens, current, tokenStart, tokenEnd);
		current = "";
		tokenStart = undefined;
	};

	for (let index = 0; index < input.length; index++) {
		const char = input[index] ?? "";
		const next = input[index + 1] ?? "";

		if (escaping) {
			beginToken(index - 1);
			current += char;
			tokenEnd = index + 1;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			if (!quote) {
				beginToken(index);
				tokenEnd = index + 1;
				escaping = true;
				continue;
			}
			if (quote === '"') {
				if (next === "\\" || next === '"' || next === "$" || next === "`") {
					beginToken(index);
					tokenEnd = index + 1;
					escaping = true;
					continue;
				}
				beginToken(index);
				current += char;
				tokenEnd = index + 1;
				continue;
			}
		}

		if (quote) {
			beginToken(index);
			tokenEnd = index + 1;
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			beginToken(index);
			tokenEnd = index + 1;
			quote = char;
			continue;
		}

		if (char === "&" && next === "&") {
			flushCurrent();
			tokens.push({ value: "&&", start: index, end: index + 2 });
			index += 1;
			continue;
		}
		if (char === "|" && next === "|") {
			flushCurrent();
			tokens.push({ value: "||", start: index, end: index + 2 });
			index += 1;
			continue;
		}
		if (char === "|" && next === "&") {
			flushCurrent();
			tokens.push({ value: "|&", start: index, end: index + 2 });
			index += 1;
			continue;
		}
		if (char === "|" || char === ";") {
			flushCurrent();
			tokens.push({ value: char, start: index, end: index + 1 });
			continue;
		}

		if (/\s/.test(char)) {
			flushCurrent();
			continue;
		}

		beginToken(index);
		current += char;
		tokenEnd = index + 1;
	}

	if (escaping) {
		current += "\\";
		tokenEnd = input.length;
	}
	flushCurrent();
	return tokens;
}

function simpleShellScript(tokens: ShellTokenSpan[]): string | undefined {
	if (tokens.length !== 3) return undefined;
	const shell = commandName(tokens[0]?.value ?? "");
	if (shell !== "bash" && shell !== "zsh" && shell !== "sh") return undefined;
	const flag = tokens[1]?.value;
	if (flag !== "-c" && flag !== "-lc") return undefined;
	return tokens[2]?.value;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function segmentHasOptionalLocksAssignment(segment: ShellTokenSpan[]): boolean {
	return segment.some((token) => token.value.startsWith("GIT_OPTIONAL_LOCKS="));
}

function applyGitOptionalLockSafetyFixups(command: string): string {
	const tokens = shellSplitWithSpans(command);
	if (tokens.length === 0) return command;
	const shellScript = simpleShellScript(tokens);
	if (shellScript) {
		const fixedScript = applyGitOptionalLockSafetyFixups(shellScript);
		if (fixedScript === shellScript) return command;
		const scriptToken = tokens[2]!;
		return `${command.slice(0, scriptToken.start)}${shellQuote(fixedScript)}${command.slice(scriptToken.end)}`;
	}

	let changed = false;
	let rewritten = "";
	let cursor = 0;
	let segment: ShellTokenSpan[] = [];

	const flush = () => {
		if (segment.length === 0) return;
		const values = segment.map((token) => token.value);
		if ((isGitSegment(values) || isRtkGitSegment(values)) && !segmentHasOptionalLocksAssignment(segment)) {
			rewritten += command.slice(cursor, segment[0]!.start);
			rewritten += "GIT_OPTIONAL_LOCKS=0 ";
			cursor = segment[0]!.start;
			changed = true;
		}
		segment = [];
	};

	for (const token of tokens) {
		if (
			token.value === "&&" ||
			token.value === "||" ||
			token.value === "|" ||
			token.value === "|&" ||
			token.value === ";"
		) {
			flush();
			continue;
		}
		segment.push(token);
	}
	flush();
	if (!changed) return command;
	rewritten += command.slice(cursor);
	return rewritten;
}

function commandHasGitFamilySegment(command: string): boolean {
	const tokens = shellSplitWithSpans(command);
	if (tokens.length === 0) return false;
	const shellScript = simpleShellScript(tokens);
	if (shellScript) return commandHasGitFamilySegment(shellScript);
	let segment: string[] = [];

	const flush = () => {
		if (segment.length === 0) return false;
		const hasGit = isGitFamilySegment(segment);
		segment = [];
		return hasGit;
	};

	for (const token of tokens) {
		if (
			token.value === "&&" ||
			token.value === "||" ||
			token.value === "|" ||
			token.value === "|&" ||
			token.value === ";"
		) {
			if (flush()) return true;
			continue;
		}
		segment.push(token.value);
	}
	return flush();
}

function rewriteRipgrepSegments(command: string): string | undefined {
	const tokens = shellSplitWithSpans(command);
	if (tokens.length === 0) return undefined;
	const shellScript = simpleShellScript(tokens);
	if (shellScript) return rewriteRipgrepSegments(shellScript);

	let changed = false;
	let rewritten = "";
	let cursor = 0;
	let segment: ShellTokenSpan[] = [];

	const flush = () => {
		if (segment.length === 0) return;
		const rgIndex = ripgrepCommandIndex(segment.map((token) => token.value));
		if (rgIndex !== undefined) {
			const rgToken = segment[rgIndex]!;
			rewritten += command.slice(cursor, rgToken.start);
			rewritten += "rtk rg";
			cursor = rgToken.end;
			changed = true;
		}
		segment = [];
	};

	for (const token of tokens) {
		if (
			token.value === "&&" ||
			token.value === "||" ||
			token.value === "|" ||
			token.value === "|&" ||
			token.value === ";"
		) {
			flush();
			continue;
		}
		segment.push(token);
	}
	flush();
	if (!changed) return undefined;
	rewritten += command.slice(cursor);
	return rewritten;
}

export function commandHasRipgrepSegment(command: string): boolean {
	return rewriteRipgrepSegments(command) !== undefined;
}

export function isRtkGrepCommand(command: string): boolean {
	const tokens = shellSplitWithSpans(command);
	const shellScript = simpleShellScript(tokens);
	if (shellScript) return isRtkGrepCommand(shellScript);
	let segment: string[] = [];
	const flush = () => {
		const index = commandIndex(segment);
		if (index === undefined) return false;
		const executable = commandName(segment[index] ?? "");
		return executable === "rtk" && segment[index + 1] === "grep";
	};

	for (const token of tokens) {
		if (
			token.value === "&&" ||
			token.value === "||" ||
			token.value === "|" ||
			token.value === "|&" ||
			token.value === ";"
		) {
			if (flush()) return true;
			segment = [];
			continue;
		}
		segment.push(token.value);
	}
	return flush();
}

function splitTopLevelPipe(command: string): { left: string; separator: "|" | "|&"; right: string } | undefined {
	let quote: '"' | "'" | "`" | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";
		const next = command[index + 1] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote) {
			if (char === "\\" && quote !== "'") {
				escaped = true;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char !== "|" || command[index - 1] === ">") continue;
		if (next === "|") return undefined;
		const separator = next === "&" ? "|&" : "|";
		const rightStart = index + separator.length;
		return {
			left: command.slice(0, index).trim(),
			separator,
			right: command.slice(rightStart).trim(),
		};
	}
	return undefined;
}

export function applyRewrittenCommandShellSafetyFixups(command: string): string {
	if (process.platform !== "win32") return command;
	const pipe = splitTopLevelPipe(command);
	if (!pipe || !/^rtk(?:\.exe)?\s+/i.test(pipe.left) || !pipe.right) return command;

	const tempFile = "__pi_rtk_pipe_tmp";
	const status = "__pi_rtk_pipe_status";
	const redirect = pipe.separator === "|&" ? `> "$${tempFile}" 2>&1` : `> "$${tempFile}"`;
	const buffered = [
		"{",
		`${tempFile}="$(mktemp)" || exit $?;`,
		`${status}=0;`,
		`trap 'rm -f "$${tempFile}"' EXIT HUP INT TERM;`,
		`${pipe.left} ${redirect};`,
		`${status}=$?;`,
		`if [ $${status} -eq 0 ]; then (${pipe.right}) < "$${tempFile}"; ${status}=$?; fi;`,
		`exit $${status};`,
		"}",
	].join(" ");
	return buffered;
}

export async function computeRtkRewriteDecision(
	pi: ExtensionAPI,
	command: string,
	enabled: boolean,
): Promise<RtkRewriteDecision> {
	if (!enabled) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "disabled" };
	}
	if (!command.trim()) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "empty" };
	}
	const gitSafeCommand = applyGitOptionalLockSafetyFixups(command);
	if (gitSafeCommand !== command) {
		return {
			changed: true,
			originalCommand: command,
			rewrittenCommand: gitSafeCommand,
			reason: "ok",
			usedRtk: false,
		};
	}
	if (commandHasGitFamilySegment(command)) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "no_match" };
	}
	if (isAlreadyRtk(command)) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "already_rtk" };
	}

	try {
		const resolution = await resolveRtkExecutable(pi);
		const result = await pi.exec(resolution.command, ["rewrite", command], { timeout: RTK_REWRITE_TIMEOUT_MS });
		if (!isExecResultLike(result)) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: "rtk rewrite returned an invalid result",
			};
		}
		if (result.code === 1) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: resolution.warning,
			};
		}
		if (result.code === 2) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: trimDetail(result.stderr) || "rtk denied rewrite",
			};
		}
		if (result.code !== 0 && result.code !== 3) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: `rtk rewrite exited ${result.code}`,
			};
		}
		const rewritten = result.stdout?.trim();
		if (!rewritten || rewritten === command) {
			return {
				changed: false,
				originalCommand: command,
				rewrittenCommand: command,
				reason: "no_match",
				warning: !rewritten ? "rtk returned empty output" : resolution.warning,
			};
		}
		return {
			changed: true,
			originalCommand: command,
			rewrittenCommand: applyRewrittenCommandShellSafetyFixups(rewritten),
			reason: "ok",
			usedRtk: true,
			warning: resolution.warning,
		};
	} catch (error) {
		return {
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			reason: "no_match",
			warning: error instanceof Error ? error.message : String(error),
		};
	}
}
