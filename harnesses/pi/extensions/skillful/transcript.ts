import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { colorize } from "./highlight";

const RENDER_WRAPPED = Symbol.for("skillful.userMessageWrapped");

export function ensureTranscriptHighlight(getSkillNames: () => Set<string>): void {
	const proto = UserMessageComponent.prototype as unknown as {
		render: (width: number) => string[];
	} & { [RENDER_WRAPPED]?: typeof proto.render };
	const current = proto.render;
	if (proto[RENDER_WRAPPED] === current) return;
	const wrapped = function (this: UserMessageComponent, width: number): string[] {
		const out = current.call(this, width);
		if (!Array.isArray(out)) return out;
		return out.map((line) => colorize(line, getSkillNames()));
	};
	proto.render = wrapped;
	proto[RENDER_WRAPPED] = wrapped;
}
