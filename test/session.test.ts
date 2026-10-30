import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageEventStream, Type, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { CONTEXT_CAP } from "../core.ts";

test("real Pi session starts uncapped, then enabled compaction continues between tool turns without aborting", { timeout: 20_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "copilot-compact-session-"));
	let calls = 0;
	let toolCalls = 0;
	let saved = false;
	const errors: string[] = [];
	const compactionEvents: unknown[] = [];
	const model = {
		...githubCopilotProvider().getModels().find(model => model.id.startsWith("gpt-"))!,
		id: "gpt-compact-test", contextWindow: 1_048_576, maxTokens: 8192,
	};
	const stream: Provider["streamSimple"] = (requestModel, _context, options) => {
		assert.equal(options?.signal?.aborted, false);
		assert.equal(requestModel.contextWindow, CONTEXT_CAP);
		calls++;
		const first = calls === 1;
		const message: AssistantMessage = {
			role: "assistant", provider: model.provider, api: model.api, model: model.id,
			timestamp: Date.now(), stopReason: first ? "toolUse" : "stop",
			content: first
				? [{ type: "toolCall", id: "test-tool-call", name: "compact_test_tool", arguments: {} }]
				: [{ type: "text", text: calls === 2 ? "Summary of the task and progress." : "Done after compaction." }],
			usage: {
				input: first ? 256_000 : 200, output: 20, cacheRead: 0, cacheWrite: 0,
				totalTokens: first ? 256_020 : 220,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const result = new AssistantMessageEventStream();
		result.push({ type: "start", partial: message });
		if (message.content[0].type === "toolCall") {
			result.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			result.push({ type: "toolcall_end", contentIndex: 0, partial: message, toolCall: message.content[0] });
		}
		result.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
		result.end();
		return result;
	};
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const runtime = await ModelRuntime.create({
			modelsPath: null, refreshOnCreate: false,
			credentials: { async read() { return undefined; }, async list() { return []; }, async modify(_id, fn) { return fn(undefined); }, async delete() {} },
		});
		runtime.registerNativeProvider({
			...githubCopilotProvider(),
			getModels: () => [model, { ...model, id: "gpt-compact-alt" }],
			getAllModels: () => [model, { ...model, id: "gpt-compact-alt" }], streamSimple: stream,
		});
		await runtime.setRuntimeApiKey("github-copilot", "test-not-a-real-credential");
		const settingsManager = SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => {
				extension(pi, { load: () => saved, save(value) { saved = value; } });
				pi.registerTool({
					name: "compact_test_tool", label: "Test", description: "Offline test tool", parameters: Type.Object({}),
					async execute() { toolCalls++; return { content: [{ type: "text", text: "Tool completed." }], details: undefined }; },
				});
				pi.on("session_start", () => pi.setActiveTools(["compact_test_tool"]));
			}],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(dir);
		for (let i = 0; i < 12; i++) {
			sessionManager.appendMessage({ role: "user", content: `Old context ${i}: ` + "background ".repeat(1200), timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant", provider: model.provider, api: model.api, model: model.id,
				content: [{ type: "text", text: "Recorded." }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			});
		}
		({ session } = await createAgentSession({
			cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager,
			sessionManager, resourceLoader,
		}));
		await session.bindExtensions({ onError: error => errors.push(String(error.error)) });
		assert.equal(session.model!.contextWindow, 1_048_576);
		await session.setModel({ ...model, id: "gpt-compact-alt" });
		assert.equal(session.model!.contextWindow, 1_048_576);
		await session.prompt("/copilot-compact on");
		assert.equal(saved, true);
		assert.equal(calls, 0);
		assert.equal(session.model!.contextWindow, CONTEXT_CAP);
		await session.setModel(model);
		assert.equal(session.model!.contextWindow, CONTEXT_CAP);
		// Simulate scoped-model snapshots selected before the extension capped the catalog.
		await session.setModel({ ...model, id: "gpt-compact-alt" });
		assert.equal(session.model!.contextWindow, CONTEXT_CAP);
		await session.setModel(model);
		assert.equal(session.model!.contextWindow, CONTEXT_CAP);
		session.subscribe(event => { if (event.type.startsWith("compaction")) compactionEvents.push(event); });
		await session.prompt("Preserve the background and call compact_test_tool.");
		assert.deepEqual(errors, []);
		assert.equal(toolCalls, 1, JSON.stringify({ calls, tools: session.getActiveToolNames(), messages: session.messages.filter(m => m.role !== "user") }));
		assert.equal(calls, 3, JSON.stringify({ compactionEvents, entries: session.sessionManager.getBranch().map(e => e.type), model: session.model!.contextWindow }));
		assert.equal(session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length, 1);
		assert.equal(session.getLastAssistantText(), "Done after compaction.");
		await session.prompt("/copilot-compact off");
		assert.equal(session.model!.contextWindow, 1_048_576);
		assert.equal(saved, false);
		await session.prompt("/copilot-compact on");
		assert.equal(session.model!.contextWindow, CONTEXT_CAP);
	} finally {
		session?.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
