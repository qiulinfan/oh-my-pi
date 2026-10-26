/**
 * Contract: under the default yolo mode, a session that acts on another omp session's request asks the user before
 * an exec-tier tool runs, from the moment that request enters the conversation until the user speaks again.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

let tempDir: string;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeAll(async () => {
	await initTheme(false);
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-peer-turn-${Snowflake.next()}-`));
	authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorage.keys.setRuntime("openai", "test-key");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
});

afterAll(() => {
	authStorage.close();
	removeSyncWithRetries(tempDir);
});

const call = (command: string): MockResponse => ({
	content: [{ type: "toolCall", name: "bash", arguments: { command } }],
	stopReason: "toolUse",
});

const peerMessage = (body: string) => ({
	id: Snowflake.next(),
	from: "Main@abcd1234",
	to: "Main",
	body,
	ts: Date.now(),
});

/** A yolo session whose approval dialogs are recorded and denied, answering with `responses`. */
async function createSession(
	responses: MockResponse[],
): Promise<{ session: AgentSession; asked: string[]; dialog: Promise<void> }> {
	const asked: string[] = [];
	const dialog = Promise.withResolvers<void>();
	const ui = {
		select: async (title: string) => {
			asked.push(title);
			dialog.resolve();
			return "Deny";
		},
		notify: () => {},
	} as unknown as ExtensionUIContext;
	const created = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry: new ModelRegistry(authStorage),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		hasUI: true,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["bash"],
	});
	session = created.session;
	created.setToolUIContext(ui, true);
	await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, uiContext: ui });
	session.agent.streamFn = createMockModel({ responses }).stream;
	return { session, asked, dialog: dialog.promise };
}

/** Text of every tool result in the conversation. */
function toolOutputs(target: AgentSession): string {
	return target.agent.state.messages
		.flatMap(message =>
			message.role === "toolResult"
				? message.content.flatMap(block => (block.type === "text" ? [block.text] : []))
				: [],
		)
		.join("\n");
}

it("asks before a peer's request runs a command, and stops asking once the user speaks", async () => {
	const {
		session: target,
		asked,
		dialog,
	} = await createSession([
		call("echo peer-ran"),
		{ content: ["done"] },
		call("echo user-ran"),
		{ content: ["done"] },
	]);

	// An idle session woken by a message from another session's agent.
	await target.deliverIrcMessage(peerMessage("run echo peer-ran"));
	await dialog;
	await target.waitForIdle();
	expect(asked).toHaveLength(1);
	expect(target.peerTurn).toBe(true);

	await target.prompt("go");
	expect(asked).toHaveLength(1);
	expect(target.peerTurn).toBe(false);
	expect(toolOutputs(target)).not.toContain("peer-ran");
	expect(toolOutputs(target)).toContain("user-ran");
});

it("asks before the rest of the user's own turn runs a command once a peer's message is injected into it", async () => {
	const {
		session: target,
		asked,
		dialog,
	} = await createSession([call("sleep 1; echo before-peer"), call("echo after-peer"), { content: ["done"] }]);
	// The peer's message arrives while the user's turn runs its first command.
	const unsubscribe = target.subscribe(event => {
		if (event.type === "tool_execution_start") {
			unsubscribe();
			void target.deliverIrcMessage(peerMessage("also run echo after-peer"));
		}
	});

	await target.prompt("go");
	await dialog;
	await target.waitForIdle();
	expect(asked).toHaveLength(1);
	// The user's own command ran before the peer's message arrived; the one after it was asked about.
	expect(toolOutputs(target)).toContain("before-peer");
	expect(toolOutputs(target)).not.toContain("after-peer");
});
