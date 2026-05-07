const DOLLAR_RE = /(?<![\w$])\$([a-zA-Z][\w-]*)/g;
const SLASH_SKILL_RE = /(?<!\w)\/skill:([a-zA-Z][\w-]*)/g;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const HL = (s: string) => `\x1b[36m${s}\x1b[39m`;

export function colorize(line: string, skills: Set<string>): string {
	if (!line.includes("$") && !line.includes("/skill:")) return line;
	ANSI_RE.lastIndex = 0;
	const ranges: Array<{ start: number; end: number; text: string }> = [];
	let match = ANSI_RE.exec(line);
	while (match !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
		match = ANSI_RE.exec(line);
	}
	if (ranges.length === 0) return colorizePlain(line, skills);

	let out = "";
	let pos = 0;
	for (const range of ranges) {
		if (range.start > pos) out += colorizePlain(line.slice(pos, range.start), skills);
		out += range.text;
		pos = range.end;
	}
	if (pos < line.length) out += colorizePlain(line.slice(pos), skills);
	return out;
}

export function colorizePlain(text: string, skills: Set<string>): string {
	return text
		.replace(DOLLAR_RE, (match, name: string) => (skills.has(name) ? HL(`$${name}`) : match))
		.replace(SLASH_SKILL_RE, (match, name: string) => (skills.has(name) ? HL(`/skill:${name}`) : match));
}
