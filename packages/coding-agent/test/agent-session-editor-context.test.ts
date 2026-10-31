import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { TspEditorContext } from "@oh-my-pi/pi-wire";

interface PromptMessage {
	customType?: string;
	content?: unknown;
}

describe("AgentSession editor context", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-editor-context-auth-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(authRoot);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	function createSession(): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Claude Sonnet model");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	}

	function place(line: number, selection?: string): TspEditorContext {
		return {
			path: path.join(session!.sessionManager.getCwd(), "notes", "plan.md"),
			line,
			col: 3,
			...(selection ? { selection } : {}),
			excerpt: { start: line - 1, text: "before\ncaret line\nafter" },
		};
	}

	/** The editor-context notices each prompt carried to the model, in order. */
	async function notices(prompts: (() => Promise<unknown>)[]): Promise<string[][]> {
		const promptSpy = vi.spyOn(session!.agent, "prompt").mockResolvedValue(undefined);
		for (const send of prompts) await send();
		return promptSpy.mock.calls.map(call =>
			(call[0] as unknown as PromptMessage[])
				.filter(message => message.customType === "editor-context")
				.map(message => String(message.content)),
		);
	}

	it("tells the model a place once, with the file relative to the project and the caret's line marked", async () => {
		session = createSession();
		session.setEditorContext(place(12, "the plan"));

		const told = await notices([() => session!.prompt("what does this say?"), () => session!.prompt("and then?")]);

		expect(told).toHaveLength(2);
		expect(told[0]).toHaveLength(1);
		const notice = told[0]![0]!;
		expect(notice).toContain(`File: ${path.join("notes", "plan.md")}`);
		expect(notice).toContain("Caret: line 12, column 3");
		expect(notice).toContain("the plan");
		expect(notice).toContain(">12 | caret line");
		expect(notice).toContain(" 11 | before");
		// The same place is not told again with the next message.
		expect(told[1]).toEqual([]);
	});

	it("tells a new place, and nothing once the user withdrew it", async () => {
		session = createSession();
		session.setEditorContext(place(4));

		const told = await notices([
			() => session!.prompt("first"),
			async () => {
				session!.setEditorContext(place(9));
				await session!.prompt("second");
			},
			async () => {
				session!.setEditorContext(null);
				await session!.prompt("third");
			},
		]);

		expect(told.map(notes => notes.length)).toEqual([1, 1, 0]);
		expect(told[1]![0]).toContain("Caret: line 9, column 3");
	});

	it("keeps the place out of the agent's own synthetic prompts", async () => {
		session = createSession();
		session.setEditorContext(place(4));

		const told = await notices([
			() => session!.prompt("continue the plan", { synthetic: true }),
			() => session!.prompt("what about here?"),
		]);

		// The synthetic prompt neither carries the place nor uses it up.
		expect(told.map(notes => notes.length)).toEqual([0, 1]);
	});
});
