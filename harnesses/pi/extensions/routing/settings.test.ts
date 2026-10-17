import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	isModelRef,
	modelName,
	ROUTING_MODEL,
	ROUTING_PROVIDER,
	type RoutingSettings,
	RoutingSettingsStore,
	routingSettingsPath,
	TIERS,
	validSettings,
} from "./settings.js";

const roots: string[] = [];
const originalStateHome = process.env.XDG_STATE_HOME;
afterEach(async () => {
	if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = originalStateHome;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function preferences(): RoutingSettings {
	const ref = (id: string) => ({ provider: "fixture", id });
	return {
		version: 1,
		classifier: ref("classifier"),
		tiers: { luna: ref("small"), sol: ref("standard"), astra: ref("strong") },
		subagents: false,
		timeoutMs: 8_000,
		maxTokens: 1_024,
	};
}
async function temporaryStore() {
	const root = await mkdtemp(join(tmpdir(), "routing-preferences-"));
	roots.push(root);
	return { root, store: new RoutingSettingsStore(join(root, "state", "preferences.json")) };
}

test("preferences roundtrip all mappings and opt-in state without adding model defaults", async () => {
	const { root, store } = await temporaryStore();
	const personal = join(root, "settings.json");
	const repository = join(root, "repository-settings.json");
	const sentinel = '{"defaultProvider":"fixture","defaultModel":"manual","extensions":[]}\n';
	await Promise.all([writeFile(personal, sentinel), writeFile(repository, sentinel)]);
	const first = preferences();
	await store.save(first);
	expect(await store.load()).toEqual(first);
	const second = { ...preferences(), subagents: true, maxTokens: 4_096 };
	await store.save(second);
	expect(await new RoutingSettingsStore(store.path).load()).toEqual(second);
	const source = await readFile(store.path, "utf8");
	expect(source.endsWith("\n")).toBe(true);
	expect(JSON.parse(source)).not.toHaveProperty("defaultModel");
	expect(JSON.parse(source)).not.toHaveProperty("defaultProvider");
	expect(await readFile(personal, "utf8")).toBe(sentinel);
	expect(await readFile(repository, "utf8")).toBe(sentinel);
	expect(await readdir(dirname(store.path))).toEqual(["preferences.json"]);
});

test("new preference directories and atomic replacement files have private POSIX modes", async () => {
	const { store } = await temporaryStore();
	await store.save(preferences());
	expect((await stat(dirname(store.path))).mode & 0o777).toBe(0o700);
	expect((await stat(store.path)).mode & 0o777).toBe(0o600);
	await rm(store.path);
	await writeFile(store.path, "old", { mode: 0o644 });
	await store.save(preferences());
	expect((await stat(store.path)).mode & 0o777).toBe(0o600);
});

test("missing preferences are unconfigured, but invalid JSON and incompatible schemas are actionable errors", async () => {
	const { store } = await temporaryStore();
	expect(await store.load()).toBeUndefined();
	await mkdir(dirname(store.path));
	await writeFile(store.path, "not JSON");
	await expect(store.load()).rejects.toThrow("invalid. Use /routing setup");
	for (const value of [null, {}, { ...preferences(), version: 2 }, { ...preferences(), subagents: "true" }]) {
		await writeFile(store.path, JSON.stringify(value));
		await expect(store.load()).rejects.toThrow("incompatible. Use /routing setup");
	}
});

test("unexpected preference filesystem errors are not mistaken for missing configuration", async () => {
	const { store } = await temporaryStore();
	await mkdir(store.path, { recursive: true });
	await expect(store.load()).rejects.toThrow();
});

test("schema validates model references, opt-in flags, and integer bounded resource limits", () => {
	expect(validSettings(preferences())).toBe(true);
	for (const changes of [
		{ version: 0 },
		{ classifier: null },
		{ classifier: { provider: "fixture", id: "" } },
		{ tiers: { luna: { provider: "fixture", id: "small" } } },
		{ subagents: undefined },
		{ subagents: 1 },
		{ timeoutMs: 999 },
		{ timeoutMs: 30_001 },
		{ timeoutMs: 1_000.5 },
		{ timeoutMs: Infinity },
		{ timeoutMs: "8000" },
		{ maxTokens: 127 },
		{ maxTokens: 4_097 },
		{ maxTokens: 256.5 },
		{ maxTokens: NaN },
		{ maxTokens: "1024" },
	])
		expect(validSettings({ ...preferences(), ...changes })).toBe(false);
	for (const timeoutMs of [1_000, 30_000]) {
		for (const maxTokens of [128, 4_096]) expect(validSettings({ ...preferences(), timeoutMs, maxTokens })).toBe(true);
	}
	for (const value of [undefined, null, [], 1, "settings"]) expect(validSettings(value)).toBe(false);
});

test("invalid saves do not create directories or overwrite an existing valid file", async () => {
	const { root, store } = await temporaryStore();
	const bad = { ...preferences(), timeoutMs: -1 };
	await expect(store.save(bad)).rejects.toThrow("Invalid routing preferences");
	expect(await readdir(root)).toEqual([]);
	await store.save(preferences());
	const before = await readFile(store.path, "utf8");
	await expect(store.save(bad)).rejects.toThrow();
	expect(await readFile(store.path, "utf8")).toBe(before);
	expect(await readdir(dirname(store.path))).toEqual(["preferences.json"]);
});

test("rename failures preserve the destination and clean atomic temporary files", async () => {
	const { store } = await temporaryStore();
	await mkdir(store.path, { recursive: true });
	const marker = join(store.path, "keep.txt");
	await writeFile(marker, "existing destination");
	await expect(store.save(preferences())).rejects.toThrow();
	expect(await readFile(marker, "utf8")).toBe("existing destination");
	expect(await readdir(dirname(store.path))).toEqual(["preferences.json"]);
});

test("concurrent saves leave one complete valid preference document and no temporary siblings", async () => {
	const { store } = await temporaryStore();
	const versions = Array.from({ length: 6 }, (_, index) => ({
		...preferences(),
		timeoutMs: 1_000 + index,
		subagents: index % 2 === 0,
	}));
	await Promise.all(versions.map((value) => store.save(value)));
	const loaded = await store.load();
	expect(versions).toContainEqual(loaded);
	expect(validSettings(loaded)).toBe(true);
	expect(await readdir(dirname(store.path))).toEqual(["preferences.json"]);
});

test("personal preference paths honour absolute XDG state homes and ignore relative roots", () => {
	process.env.XDG_STATE_HOME = "/tmp/personal-routing-state";
	expect(routingSettingsPath()).toBe("/tmp/personal-routing-state/agent-routing/preferences.json");
	process.env.XDG_STATE_HOME = "relative-state";
	expect(routingSettingsPath()).toBe(join(homedir(), ".local", "state", "agent-routing", "preferences.json"));
	delete process.env.XDG_STATE_HOME;
	expect(routingSettingsPath()).toBe(join(homedir(), ".local", "state", "agent-routing", "preferences.json"));
});

test("model identities are explicit, trimmed physical references rather than aliases or provider selectors", () => {
	expect(ROUTING_PROVIDER).toBe("routing");
	expect(ROUTING_MODEL).toBe("auto");
	expect(TIERS).toEqual(["luna", "sol", "astra"]);
	expect(isModelRef({ provider: "fixture", id: "namespace/model" })).toBe(true);
	expect(modelName({ provider: "fixture", id: "namespace/model" })).toBe("fixture/namespace/model");
	for (const value of [
		undefined,
		null,
		"alias",
		{},
		{ provider: "", id: "model" },
		{ provider: "fixture", id: "" },
		{ provider: " fixture", id: "model" },
		{ provider: "fixture/other", id: "model" },
		{ provider: "fixture", id: "model " },
	])
		expect(isModelRef(value)).toBe(false);
});
