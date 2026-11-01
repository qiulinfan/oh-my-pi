import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// A turn the provider had to retry without priority, as the Anthropic provider
// reports one: `disabledFeatures: ["priority"]`.
function priorityRejectedStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			disabledFeatures: ["priority"],
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("AgentSession fast mode after a model rejects priority", () => {
	let dir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		dir = TempDir.createSync("@pi-fast-mode-fallback-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		dir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	// Turning fast mode off for the whole family on one model's rejection (a
	// subagent's smaller model, say) slowed every other model down.
	it("keeps fast mode on and says so once per model", async () => {
		const model = createMockModel({ provider: "anthropic", id: "claude-small" }).model;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requested => priorityRejectedStream(requested),
			convertToLlm,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"advisor.enabled": false,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.setServiceTierFamily("anthropic", "priority");
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "priority") notices.push(event);
		});

		await session.prompt("First");
		await session.waitForIdle();
		await session.prompt("Second");
		await session.waitForIdle();

		expect(session.serviceTierByFamily.anthropic).toBe("priority");
		expect(notices).toHaveLength(1);
		expect(notices[0].message).toContain("claude-small");
	});
});
