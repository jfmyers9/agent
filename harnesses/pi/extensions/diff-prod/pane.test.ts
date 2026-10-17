import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DiffPane, type MountPane, type PaneDefinition, type PaneHost } from "./pane";

function fixture(read: () => Promise<string> = async () => "+production\n", title?: () => string) {
	const terminal = { columns: 140, rows: 24, fullscreen: true };
	let definition: PaneDefinition | undefined;
	let component: ReturnType<PaneDefinition["component"]> | undefined;
	let mounts = 0;
	let unmounts = 0;
	let renders = 0;
	let focused = false;
	const host = {
		tui: { hasOverlay: () => false },
		getTerminalSize: () => terminal,
		requestRender: () => {
			renders++;
		},
		focus: () => {
			focused = true;
		},
		blur: () => {
			focused = false;
		},
		isFocused: () => focused,
	} as PaneHost;
	const mount: MountPane = (spec) => {
		definition = spec;
		mounts++;
		component = spec.component(host, { fg: (_color: string, text: string) => text } as Theme);
		return () => {
			unmounts++;
			component?.dispose();
			component = undefined;
			focused = false;
		};
	};
	const pane = new DiffPane(read, () => terminal, mount, title);
	return {
		pane,
		terminal,
		host,
		get definition() {
			return definition;
		},
		get component() {
			return component;
		},
		get mounts() {
			return mounts;
		},
		get unmounts() {
			return unmounts;
		},
		get renders() {
			return renders;
		},
	};
}

test("auto-shows without taking focus and restores full width on hide or resize", async () => {
	const f = fixture();
	await f.pane.refresh();
	expect(f.definition?.position).toBe("right");
	expect(f.definition?.minMainSize).toBe(72);
	expect(f.definition?.priority).toBeLessThan(0);
	expect(f.mounts).toBe(1);
	expect(f.host.isFocused()).toBe(false);
	expect(f.pane.focus()).toBe(true);
	expect(f.host.isFocused()).toBe(true);
	f.component?.handleInput?.("\x1b");
	expect(f.host.isFocused()).toBe(false);
	f.pane.focus();
	f.pane.focus();
	expect(f.host.isFocused()).toBe(false);
	f.terminal.columns = 119;
	f.pane.syncLayout();
	expect(f.unmounts).toBe(1);
	expect(f.pane.focus()).toBe(false);
	f.terminal.columns = 120;
	f.pane.syncLayout();
	expect(f.mounts).toBe(2);
	f.terminal.fullscreen = false;
	f.pane.syncLayout();
	expect(f.unmounts).toBe(2);
	f.terminal.fullscreen = true;
	f.pane.syncLayout();
	expect(f.mounts).toBe(3);
	f.terminal.rows = 5;
	f.pane.syncLayout();
	expect(f.unmounts).toBe(3);
	f.terminal.rows = 24;
	f.pane.syncLayout();
	expect(f.mounts).toBe(4);
	expect(f.pane.toggle()).toBe(false);
	expect(f.unmounts).toBe(4);
	f.pane.syncLayout();
	expect(f.mounts).toBe(4);
	f.pane.dispose();
	f.pane.dispose();
	expect(f.unmounts).toBe(4);
});

test("updates visible content in place, hides clean or failed diff, and retries", async () => {
	let diff = "+before";
	let fail = false;
	const f = fixture(async () => {
		if (fail) throw new Error("git failed");
		return diff;
	});
	await f.pane.refresh();
	const first = f.component;
	diff = "+after";
	await f.pane.refresh();
	expect(f.component).toBe(first);
	expect(f.mounts).toBe(1);
	expect(f.component?.render(50).join("\n")).toContain("+after");
	const renders = f.renders;
	await f.pane.refresh();
	expect(f.renders).toBe(renders);
	diff = "";
	await f.pane.refresh();
	expect(f.unmounts).toBe(1);
	diff = "+back";
	await f.pane.refresh();
	expect(f.mounts).toBe(2);
	fail = true;
	await f.pane.refresh();
	expect(f.unmounts).toBe(2);
	fail = false;
	await f.pane.refresh();
	expect(f.mounts).toBe(3);
	f.pane.dispose();
	expect(f.unmounts).toBe(3);
});

test("does not mount for empty, narrow, or regular-mode sessions", async () => {
	for (const state of [{ columns: 90 }, { fullscreen: false }, { rows: 3 }]) {
		const f = fixture();
		Object.assign(f.terminal, state);
		await f.pane.refresh();
		expect(f.mounts).toBe(0);
		f.pane.dispose();
	}
	const f = fixture(async () => "");
	await f.pane.refresh();
	expect(f.mounts).toBe(0);
	f.pane.dispose();
});

test("refresh requests coalesce, and disposal ignores in-flight reads", async () => {
	let resolve!: (value: string) => void;
	let calls = 0;
	const f = fixture(() => {
		calls++;
		return new Promise((r) => {
			resolve = r;
		});
	});
	const pending = f.pane.refresh();
	f.pane.refresh();
	f.pane.refresh();
	expect(calls).toBe(1);
	resolve("+first");
	await Promise.resolve();
	expect(calls).toBe(2);
	resolve("+second");
	await pending;
	expect(f.component?.render(50).join("\n")).toContain("+second");
	const disposed = f.pane.refresh();
	f.pane.dispose();
	resolve("+stale");
	await disposed;
	expect(f.component).toBeUndefined();
	expect(f.mounts).toBe(1);
	await f.pane.refresh();
	expect(calls).toBe(3);
});

test("disabled panes do not poll Git and re-enable refreshes", async () => {
	let calls = 0;
	const f = fixture(async () => {
		calls++;
		return "+diff";
	});
	f.pane.setEnabled(false);
	await f.pane.refresh();
	expect(calls).toBe(0);
	f.pane.setEnabled(true);
	await f.pane.refresh();
	expect(calls).toBeGreaterThan(0);
	expect(f.mounts).toBe(1);
	f.pane.dispose();
});

test("refresh arriving between drain completion and promise cleanup is not lost", async () => {
	let diff = "+first";
	const f = fixture(async () => diff);
	const pending = f.pane.refresh();
	await Promise.resolve();
	diff = "+latest";
	f.pane.refresh();
	await pending;
	expect(f.component?.render(80).join("\n")).toContain("+latest");
	f.pane.dispose();
});

test("clearing an interaction hides immediately and discards an in-flight read", async () => {
	let resolve!: (diff: string) => void;
	let delayed = false;
	const f = fixture(() =>
		delayed
			? new Promise((r) => {
					resolve = r;
				})
			: Promise.resolve("+completed"),
	);
	await f.pane.refresh();
	expect(f.mounts).toBe(1);
	delayed = true;
	const pending = f.pane.refresh();
	f.pane.clear();
	expect(f.component).toBeUndefined();
	resolve("+previous turn");
	await pending;
	expect(f.component).toBeUndefined();
	expect(f.mounts).toBe(1);
	f.pane.dispose();
});

test("scope changes relabel identical diffs and cannot show stale repository results", async () => {
	let title = "Repository";
	let read: () => Promise<string> = async () => "+same";
	const f = fixture(
		() => read(),
		() => title,
	);
	await f.pane.refresh();
	expect(f.component?.render(80)[0]).toBe("Repository");
	title = "This turn";
	await f.pane.refresh();
	expect(f.component?.render(80)[0]).toBe("This turn");
	let resolve!: (diff: string) => void;
	read = () =>
		new Promise((r) => {
			resolve = r;
		});
	const pending = f.pane.refresh();
	f.pane.clear();
	read = async () => "+current turn";
	f.pane.refresh();
	resolve("+stale repository");
	await pending;
	expect(f.component?.render(80).join("\n")).toContain("+current turn");
	expect(f.component?.render(80).join("\n")).not.toContain("+stale repository");
	f.pane.dispose();
});
