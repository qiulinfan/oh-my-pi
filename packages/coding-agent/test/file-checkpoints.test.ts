/**
 * File checkpoints: omp's file tools record each file's prior state once per
 * user turn, and a code rewind to a user message writes those states back
 * (deleting files that did not exist). Snapshots live in the session's
 * artifacts directory, survive reopening the session, and obey the size cap.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	FILE_CHECKPOINTS_DIRNAME,
	type FileCheckpointLimits,
	FileCheckpointStore,
} from "@oh-my-pi/pi-coding-agent/session/file-checkpoints";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const UNLIMITED: FileCheckpointLimits = {
	maxBytes: Number.MAX_SAFE_INTEGER,
	maxAgeMs: Number.MAX_SAFE_INTEGER,
	maxFileBytes: Number.MAX_SAFE_INTEGER,
};

let root: string;
let projectDir: string;
let sessionDir: string;
let previousAgentDir: string;

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-checkpoints-"));
	projectDir = path.join(root, "project");
	sessionDir = path.join(root, "sessions");
	await fs.mkdir(projectDir, { recursive: true });
	// Custom session dirs leave a breadcrumb in the agent dir; keep it in the temp root.
	previousAgentDir = getAgentDir();
	setAgentDir(path.join(root, "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(previousAgentDir);
	resetSettingsForTest();
	await removeWithRetries(root);
});

function userTurn(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function assistantReply(manager: SessionManager, text: string): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AgentMessage as Parameters<SessionManager["appendMessage"]>[0]);
}

function createStore(manager: SessionManager, limits: FileCheckpointLimits = UNLIMITED): FileCheckpointStore {
	return new FileCheckpointStore(manager, { enabled: () => true, limits: () => limits });
}

function toolSession(store: FileCheckpointStore): ToolSession {
	return {
		cwd: projectDir,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated(),
		fileCheckpoints: store,
	} as unknown as ToolSession;
}

async function applyPatch(session: ToolSession, input: string): Promise<void> {
	const result = await new EditTool(session, "apply_patch").execute("patch", { input });
	expect(result.isError).not.toBe(true);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Turn 1 creates `a.txt`; turn 2 edits it twice and creates `new.txt`.
 * Returns the two user-message entry ids.
 */
async function runTwoTurns(manager: SessionManager, session: ToolSession): Promise<{ u1: string; u2: string }> {
	const write = new WriteTool(session);
	const u1 = userTurn(manager, "create a");
	await write.execute("w1", { path: "a.txt", content: "one\n" });
	assistantReply(manager, "created");

	const u2 = userTurn(manager, "change a, add new");
	await applyPatch(session, "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** End Patch\n");
	await applyPatch(session, "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+three\n*** End Patch\n");
	await write.execute("w2", { path: "new.txt", content: "fresh\n" });
	assistantReply(manager, "changed");
	return { u1, u2 };
}

describe("file checkpoints", () => {
	it("restores a turn's write and edits: content returns and the created file is removed", async () => {
		const manager = SessionManager.create(projectDir, sessionDir);
		const store = createStore(manager);
		const { u1, u2 } = await runTwoTurns(manager, toolSession(store));
		const a = path.join(projectDir, "a.txt");
		const created = path.join(projectDir, "new.txt");
		expect(await Bun.file(a).text()).toBe("three\n");

		const plan = await store.planRestore(u2);
		expect(plan.complete).toBe(true);
		expect(plan.changes.map(change => [path.basename(change.path), change.action])).toEqual([
			["a.txt", "modify"],
			["new.txt", "delete"],
		]);
		const result = await store.applyRestore(plan);
		expect(result.failed).toEqual([]);
		expect(await Bun.file(a).text()).toBe("one\n");
		expect(await exists(created)).toBe(false);

		// Before turn 1 the file did not exist at all.
		const toStart = await store.planRestore(u1);
		expect(toStart.changes.map(change => [path.basename(change.path), change.action])).toEqual([["a.txt", "delete"]]);
		await store.applyRestore(toStart);
		expect(await exists(a)).toBe(false);
	});

	it("restores snapshots after the session is reopened", async () => {
		const manager = SessionManager.create(projectDir, sessionDir);
		const { u2 } = await runTwoTurns(manager, toolSession(createStore(manager)));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const store = createStore(reopened);
		const plan = await store.planRestore(u2);
		expect(plan.changes.map(change => path.basename(change.path))).toEqual(["a.txt", "new.txt"]);
		await store.applyRestore(plan);
		expect(await Bun.file(path.join(projectDir, "a.txt")).text()).toBe("one\n");
		expect(await exists(path.join(projectDir, "new.txt"))).toBe(false);
		await reopened.close();
	});

	it("drops the oldest turn past the size cap and refuses to restore across it", async () => {
		const manager = SessionManager.create(projectDir, sessionDir);
		const store = createStore(manager, { ...UNLIMITED, maxBytes: 150 });
		const session = toolSession(store);
		const write = new WriteTool(session);
		await Bun.write(path.join(projectDir, "first.txt"), "x".repeat(100));
		await Bun.write(path.join(projectDir, "second.txt"), "y".repeat(100));

		const u1 = userTurn(manager, "one");
		await write.execute("w1", { path: "first.txt", content: "changed\n" });
		const firstBlobs = await fs.readdir(path.join(manager.getArtifactsDir()!, FILE_CHECKPOINTS_DIRNAME, "blobs"));
		expect(firstBlobs).toHaveLength(1);
		assistantReply(manager, "ok");

		const u2 = userTurn(manager, "two");
		await write.execute("w2", { path: "second.txt", content: "changed\n" });

		expect((await store.records()).map(record => record.turn)).toEqual([u2]);
		const blobs = await fs.readdir(path.join(manager.getArtifactsDir()!, FILE_CHECKPOINTS_DIRNAME, "blobs"));
		expect(blobs).not.toContain(firstBlobs[0]);

		const truncated = await store.planRestore(u1);
		expect(truncated.complete).toBe(false);
		await expect(store.applyRestore(truncated)).rejects.toThrow("removed by retention");
		expect((await store.planRestore(u2)).complete).toBe(true);
	});
});

describe("rewind scope choice in /tree", () => {
	type Answer = "Restore conversation only" | "Restore code only" | "Restore conversation and code";

	async function rewindThroughTree(answer: Answer) {
		const manager = SessionManager.create(projectDir, sessionDir);
		const store = createStore(manager);
		const { u2 } = await runTwoTurns(manager, toolSession(store));

		const settled = Promise.withResolvers<void>();
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const titles: string[] = [];
		const showHookSelector = vi.fn(async (title: string) => {
			titles.push(title);
			return answer;
		});
		let selector: { handleInput(key: string): void } | undefined;
		const ctx = {
			sessionManager: manager,
			ui: { terminal: { rows: 40 }, setFocus: vi.fn(), requestRender: vi.fn(), requestComponentRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: { getText: () => "", setText: vi.fn(), setDraft: vi.fn(), onEscape: undefined },
			showStatus: vi.fn(() => settled.resolve()),
			showError: vi.fn((message: string) => settled.reject(new Error(message))),
			showWarning: vi.fn(),
			showHookSelector,
			keybindings: { getKeys: () => ["escape"] },
			chatContainer: { addChild: vi.fn() },
			statusContainer: { addChild: vi.fn(), disposeChildren: vi.fn() },
			renderInitialMessages: vi.fn(async () => {}),
			truncateTranscriptFromMessage: vi.fn(() => false),
			reloadTodos: vi.fn(async () => {}),
			session: { navigateTree, abortBranchSummary: vi.fn(), fileCheckpoints: store },
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		controller.showSelector = create => {
			selector = create(() => {}).component as { handleInput(key: string): void };
		};

		controller.showTreeSelector();
		// The leaf is turn 2's reply; one step up selects turn 2's user message.
		selector!.handleInput("\x1b[A");
		selector!.handleInput("\r");
		await settled.promise;
		return { navigateTree, titles, u2 };
	}

	it("conversation only moves the leaf and leaves files alone", async () => {
		const { navigateTree, titles, u2 } = await rewindThroughTree("Restore conversation only");
		expect(titles[0]).toContain("M a.txt");
		expect(titles[0]).toContain("D new.txt");
		expect(navigateTree).toHaveBeenCalledWith(u2, expect.objectContaining({ summarize: false }));
		expect(await Bun.file(path.join(projectDir, "a.txt")).text()).toBe("three\n");
		expect(await exists(path.join(projectDir, "new.txt"))).toBe(true);
	});

	it("code only restores files without moving the leaf", async () => {
		const { navigateTree } = await rewindThroughTree("Restore code only");
		expect(navigateTree).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(projectDir, "a.txt")).text()).toBe("one\n");
		expect(await exists(path.join(projectDir, "new.txt"))).toBe(false);
	});
});
