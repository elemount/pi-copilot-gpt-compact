import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { ModelRuntime, shouldCompact, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { capModel, CONTEXT_CAP, isCopilotGpt, preferenceStore, withContextCap } from "../core.ts";
import extension from "../index.ts";

const gpt = (id = "gpt-6.1-sol", contextWindow = 1_048_576): Model<any> => ({
	id, provider: "github-copilot", name: id, api: "openai-responses",
	baseUrl: "https://example.invalid", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 32_768,
});

function providerFixture(): Provider {
	return { ...githubCopilotProvider(), getModels: () => [gpt(), gpt("claude-sonnet-4.6", 1_000_000)] };
}

test("only Copilot GPT chat models are capped; original objects and smaller windows survive", () => {
	const model = gpt();
	assert.equal(capModel(model).contextWindow, CONTEXT_CAP);
	assert.equal(model.contextWindow, 1_048_576);
	assert.equal(capModel(model).maxTokens, model.maxTokens);
	for (const unchanged of [gpt("claude-sonnet-4.6"), gpt("gpt-4o", 128_000), { ...model, provider: "openai" }]) {
		assert.equal(capModel(unchanged), unchanged);
	}
	assert.equal(isCopilotGpt(undefined), false);
	assert.equal(isCopilotGpt(gpt("GPT-5.4")), true);
	assert.equal(isCopilotGpt(gpt("not-gpt-5")), false);
});

test("272k cap activates native compaction at 255,616 with default reserve", () => {
	const model = capModel(gpt());
	assert.equal(shouldCompact(255_616, model.contextWindow, DEFAULT_COMPACTION_SETTINGS), false);
	assert.equal(shouldCompact(255_617, model.contextWindow, DEFAULT_COMPACTION_SETTINGS), true);
	assert.equal(shouldCompact(271_999, model.contextWindow, DEFAULT_COMPACTION_SETTINGS), true);
});

test("wrapper preserves authentication, refresh, method receivers and newly discovered models", async () => {
	let models = [gpt()];
	const original = {
		...providerFixture(),
		marker: 7,
		getModels() { assert.equal(this.marker, 7); return models; },
		getAllModels() { return this.getModels(); },
		async refreshModels() { assert.equal(this.marker, 7); models = [gpt("gpt-7")]; },
	};
	const wrapped = withContextCap(original);
	assert.equal(wrapped.auth, original.auth);
	assert.equal(wrapped.getModels()[0].contextWindow, CONTEXT_CAP);
	await wrapped.refreshModels!({} as any);
	assert.equal(wrapped.getModels()[0].id, "gpt-7");
	assert.equal(wrapped.getAllModels!()[0].contextWindow, CONTEXT_CAP);
	assert.equal(original.getModels()[0].contextWindow, 1_048_576);
});

test("image and classifier models are not changed", () => {
	const original = providerFixture();
	const image = { type: "image", id: "gpt-image-1", provider: "github-copilot", api: "images" } as any;
	const classifier = { ...gpt(), type: "classifier" } as any;
	const wrapped = withContextCap({ ...original, getAllModels: () => [gpt(), image, classifier] });
	const all = wrapped.getAllModels!();
	assert.equal(all[0].contextWindow, CONTEXT_CAP);
	assert.equal(all[1], image);
	assert.equal(all[2], classifier);
});

test("preference defaults on, survives reload, rejects invalid data, and leaves no temp files", () => {
	const dir = mkdtempSync(join(tmpdir(), "copilot-compact-"));
	try {
		const path = join(dir, "preference.json");
		const store = preferenceStore(path);
		assert.equal(store.load(), true);
		store.save(false);
		assert.equal(preferenceStore(path).load(), false);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: false });
		store.save(true);
		assert.equal(store.load(), true);
		assert.deepEqual(readdirSync(dir), ["preference.json"]);
		for (const invalid of ['{"enabled":"false"}', "null", "{}", "invalid JSON"]) {
			writeFileSync(path, invalid);
			assert.throws(() => store.load());
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

function harness(initial = true, saveFails = false) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const statusCalls: { key: string; text: string | undefined }[] = [];
	const original = providerFixture();
	let active = original;
	let saved = initial;
	let idleWaits = 0;
	const ctx: any = {
		hasUI: true,
		get model() { return active.getModels()[0]; },
		modelRegistry: { getProvider: () => active },
		ui: {
			setStatus(key: string, text: string | undefined) { statusCalls.push({ key, text }); },
			notify(message: string) { notices.push(message); },
		},
		async waitForIdle() { idleWaits++; },
	};
	extension({
		on(name: string, handler: Function) { handlers.set(name, handler); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerProvider(provider: Provider) { active = provider; },
		getSettings() { return {}; },
	} as any, { load: () => saved, save(value) { if (saveFails) throw new Error("read-only"); saved = value; } });
	return {
		start: () => handlers.get("session_start")!({}, ctx),
		event: (name: string) => handlers.get(name)!({}, ctx),
		command: (args: string) => commands.get("copilot-compact").handler(args, ctx),
		ctx, notices, statusCalls, original, active: () => active, saved: () => saved, idleWaits: () => idleWaits,
	};
}

test("default-on command can turn off/on, toggle, persist and report status without model calls", async () => {
	const h = harness();
	h.start();
	assert.equal(h.ctx.model.contextWindow, CONTEXT_CAP);
	await h.command("off");
	assert.equal(h.active(), h.original);
	assert.equal(h.saved(), false);
	assert.equal(h.ctx.model.contextWindow, 1_048_576);
	await h.command("on");
	assert.equal(h.ctx.model.contextWindow, CONTEXT_CAP);
	await h.command("toggle");
	assert.equal(h.saved(), false);
	await h.command("status");
	assert.match(h.notices.at(-1)!, /off/);
	await h.command("invalid");
	assert.match(h.notices.at(-1)!, /Usage:/);
	assert.equal(h.idleWaits(), 3);
});

test("lifecycle events and commands never add a persistent UI status", async () => {
	for (const initial of [true, false]) {
		const h = harness(initial);
		h.start();
		h.event("model_select");
		h.event("before_agent_start");
		for (const action of ["off", "on", "toggle", "status"]) await h.command(action);
		assert.deepEqual(h.statusCalls, []);
		assert.match(h.notices.at(-1)!, /Copilot GPT early compaction:/);
	}
});

test("saved off preference is respected on startup and session switches", async () => {
	const h = harness(false);
	h.start();
	assert.equal(h.ctx.model.contextWindow, 1_048_576);
	await h.command("on");
	h.start();
	assert.equal(h.ctx.model.contextWindow, CONTEXT_CAP);
	await h.command("off");
	h.start();
	assert.equal(h.ctx.model.contextWindow, 1_048_576);
});

test("failed preference writes do not change the running option", async () => {
	const h = harness(true, true);
	h.start();
	await h.command("off");
	assert.equal(h.ctx.model.contextWindow, CONTEXT_CAP);
	assert.match(h.notices.at(-1)!, /Cannot save/);
});

test("real Pi ModelRuntime uses the capped catalog and restores original windows", async () => {
	const runtime = await ModelRuntime.create({
		modelsPath: null, refreshOnCreate: false,
		credentials: { async read() { return undefined; }, async list() { return []; }, async modify(_id, fn) { return fn(undefined); }, async delete() {} },
	});
	const original = runtime.getProvider("github-copilot")!;
	const before = original.getModels();
	assert.ok(before.some(model => isCopilotGpt(model) && model.contextWindow > CONTEXT_CAP));
	runtime.registerNativeProvider(withContextCap(original));
	for (const model of before) {
		const current = runtime.getModel(model.provider, model.id)!;
		assert.equal(current.contextWindow, isCopilotGpt(model) ? Math.min(model.contextWindow, CONTEXT_CAP) : model.contextWindow);
	}
	runtime.registerNativeProvider(original);
	for (const model of before) assert.equal(runtime.getModel(model.provider, model.id)!.contextWindow, model.contextWindow);
});
