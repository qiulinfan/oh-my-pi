import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, createSyntheticToolResultMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	collectPendingToolCalls,
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	hasRestorableTurn,
	INTERRUPTED_TURN_ERROR,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { readSessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_repro",
			name: "bash",
			arguments: { command: "bun run check:ts" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

describe("session exit diagnostics", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("records a durable tool start marker and shutdown diagnostic before a pending result exists", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		const marker = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
		if (marker?.type !== "custom") throw new Error("Expected tool execution start marker");
		expect(marker.data).toMatchObject({
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});

		const pending = collectPendingToolCalls(sessionManager.getBranch());
		expect(pending).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");

		await session.dispose();
		session = undefined;
		// dispose() released the in-memory transcript; the exit marker's contract
		// is durability, so assert against the persisted file.
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const exitEntry = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		await reopened.close();
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "dispose",
			kind: "normal",
			pendingToolCalls: [
				{
					toolCallId: "toolu_repro",
					toolName: "bash",
					args: { command: "bun run check:ts" },
				},
			],
		});
	});

	it("signal teardown persists the postmortem reason, not the generic dispose", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-signal-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const activeSession = session;

		// The assistant message persists through an async queue; the tool start
		// marker is appended synchronously and is what makes the session durable
		// enough for #recordSessionExit to write the exit entry (same setup as
		// the plain-dispose test above).
		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		// Mirror InteractiveMode.init(): the postmortem "session-teardown"
		// callback runs FIRST on SIGTERM/SIGHUP/uncaughtException (reverse
		// registration order) and calls dispose(). Without reason threading,
		// #doDispose would persist the generic "dispose"/"normal" and cancel the
		// reason-specific agent-session recorder — losing the real trigger.
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => activeSession.beginDispose(),
			saveDraft: async () => {},
			disposeSession: reason => activeSession.dispose({ reason }),
		});

		await teardown(postmortem.Reason.SIGTERM);
		session = undefined;

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const exitEntry = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		await reopened.close();
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "sigterm",
			kind: "signal",
		});
	});

	/** A store in a fresh temp dir, and AgentSessions over its session files answering from a mock model. */
	async function openStore(prefix: string) {
		tempDir = TempDir.createSync(prefix);
		const dir = tempDir.path();
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		/**
		 * `abortSettlesLate`: the agent ends the turn a teardown aborts only once the session
		 * has stopped listening to it. In a real omp the abort crosses the agent loop and the
		 * provider stream first, and a teardown with no terminal left to write to gets there
		 * sooner.
		 */
		const open = (
			manager: SessionManager,
			responses: (MockResponse | (() => MockResponse))[],
			options: { abortSettlesLate?: boolean; streamFn?: StreamFn } = {},
		) => {
			const mock = createMockModel({ responses });
			const agent = new Agent({
				getApiKey: (target: Model) => `${target.provider}-test-key`,
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
				streamFn: options.streamFn ?? mock.stream,
			});
			if (options.abortSettlesLate) {
				const stoppedListening = Promise.withResolvers<void>();
				const subscribe = agent.subscribe.bind(agent);
				vi.spyOn(agent, "subscribe").mockImplementation(listener => {
					const unsubscribe = subscribe(listener);
					return () => {
						unsubscribe();
						stoppedListening.resolve();
					};
				});
				const abort = agent.abort.bind(agent);
				vi.spyOn(agent, "abort").mockImplementation(reason => {
					void stoppedListening.promise.then(() => abort(reason));
				});
			}
			const opened = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
			session = opened;
			return { session: opened, mock };
		};
		/** A reply that streams until something aborts it; `streaming` settles once it has begun. */
		const streamingReply = () => {
			const started = Promise.withResolvers<void>();
			const reply = (): MockResponse => {
				started.resolve();
				return { delayMs: 60_000, content: ["never sent"] };
			};
			return { reply, streaming: started.promise };
		};
		/** Whether `omp --restore <sessionFile>` goes on with its turn, and the reply then ends it. */
		const restores = async (sessionFile: string): Promise<boolean> => {
			const reopened = await SessionManager.open(sessionFile, dir);
			const { session: restored, mock } = open(reopened, [{ content: ["the story"] }]);
			const wentOn = await restored.restoreInterruptedTurn();
			await restored.waitForIdle();
			expect(mock.calls.length).toBe(wentOn ? 1 : 0);
			if (wentOn) {
				const last = restored.agent.state.messages.at(-1);
				expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "the story" });
			}
			return wentOn;
		};
		/** A reply that streams signed thinking and the start of its text, then waits for an abort. */
		const partialReply: StreamFn = target => {
			const stream = new AssistantMessageEventStream();
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: target.api,
				provider: target.provider,
				model: target.id,
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
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				partial.content.push({ type: "thinking", thinking: "A lighthouse.", thinkingSignature: "sig" });
				stream.push({ type: "thinking_start", contentIndex: 0, partial });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: "A lighthouse.", partial });
				stream.push({ type: "thinking_end", contentIndex: 0, content: "A lighthouse.", partial });
				partial.content.push({ type: "text", text: "Once upon" });
				stream.push({ type: "text_start", contentIndex: 1, partial });
				stream.push({ type: "text_delta", contentIndex: 1, delta: "Once upon", partial });
			});
			return stream;
		};
		/**
		 * Prompt a first reply and run the interactive teardown for `reason` once it has
		 * streamed some text, before any assistant entry exists; the path of its session file.
		 */
		const cutOffFirstReply = async (
			reason: postmortem.Reason | undefined,
			options?: { abortSettlesLate?: boolean },
		): Promise<string> => {
			const sessionManager = SessionManager.create(dir, dir);
			const { session: activeSession } = open(sessionManager, [], { ...options, streamFn: partialReply });
			const streamed = Promise.withResolvers<void>();
			const stopWatching = activeSession.subscribe(event => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
					streamed.resolve();
			});
			const prompted = activeSession.prompt("tell a long story");
			await streamed.promise;
			stopWatching();
			await createSessionTeardown({
				getDraftText: () => "",
				beginDispose: () => activeSession.beginDispose(),
				saveDraft: async () => {},
				disposeSession: reason => activeSession.dispose({ reason }),
			})(reason);
			await prompted.catch(() => {});
			session = undefined;
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a session file path");
			return sessionFile;
		};
		return { dir, open, streamingReply, restores, cutOffFirstReply };
	}

	// A GUI stop (SIGTERM) or a closed terminal signals omp while its first reply streams,
	// before any assistant entry exists. Quitting mid-reply disposes it with no signal, and
	// SIGINT is Ctrl+C where omp's terminal is not raw (`omp -p`): both are the user
	// stopping it. Only the first leaves a turn `omp --restore` goes on with, and the
	// listing says which.
	for (const reason of [postmortem.Reason.SIGTERM, postmortem.Reason.SIGINT, undefined]) {
		const restorable = reason === postmortem.Reason.SIGTERM;
		it(`${restorable ? "keeps" : "leaves"} a reply cut off by ${reason ?? "quitting"} ${restorable ? "restorable" : "as the user stopped it"}`, async () => {
			const store = await openStore("@pi-session-exit-mid-reply-");
			const sessionFile = await store.cutOffFirstReply(reason);
			expect(await readSessionInfo(sessionFile)).toMatchObject({
				status: restorable ? "interrupted" : "aborted",
				restorable,
			});
			expect(await store.restores(sessionFile)).toBe(restorable);
		});
	}

	// When its terminal goes away (a closed PTY, a killed GUI server), or the user quits
	// mid-reply, omp's teardown can unsubscribe from the agent before the agent has ended
	// the reply it was asked to abort. That reply still has to reach the session file, as
	// the record a teardown that kept listening writes: completed, its prompt digest ahead
	// of it. On a first turn nothing else would ever create the file, so the prompt would be
	// lost with it and there would be nothing to restore.
	for (const reason of [postmortem.Reason.SIGHUP, undefined]) {
		const restorable = reason === postmortem.Reason.SIGHUP;
		it(`saves a first reply cut off by ${reason ?? "quitting"} the same when the agent ends it after the teardown stopped listening`, async () => {
			const store = await openStore("@pi-session-exit-late-abort-");
			/** The session file's messages and custom entries, as the fields restore and listing read. */
			const records = async (sessionFile: string) =>
				(await Bun.file(sessionFile).text())
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line))
					.flatMap(entry => {
						if (entry.type === "custom") return [entry.customType];
						if (entry.type !== "message") return [];
						const { role, stopReason, errorMessage, content, completedAt } = entry.message;
						return role === "assistant"
							? [
									{
										role,
										stopReason,
										errorMessage,
										content: content.map((block: { type: string }) => block.type),
										completed: typeof completedAt === "number",
									},
								]
							: [role];
					});
			const sessionFiles: string[] = [];
			for (const abortSettlesLate of [false, true]) {
				const sessionFile = await store.cutOffFirstReply(reason, { abortSettlesLate });
				expect(await readSessionInfo(sessionFile)).toMatchObject({
					status: restorable ? "interrupted" : "aborted",
					restorable,
				});
				sessionFiles.push(sessionFile);
			}
			const [heard, late] = await Promise.all(sessionFiles.map(records));
			expect(heard).toEqual([
				"user",
				// Recorded as the teardown began, under the prompt: no reply existed yet.
				"session_exit",
				"system-prompt-digest",
				{
					role: "assistant",
					stopReason: "aborted",
					errorMessage: restorable ? INTERRUPTED_TURN_ERROR : "Request was aborted",
					content: ["thinking", "text"],
					completed: true,
				},
			]);
			expect(late).toEqual(heard);
			expect(await store.restores(sessionFiles[1])).toBe(restorable);
		});
	}

	// A parent's signal teardown aborts each subagent's turn through `abort()` with no
	// reason, after the signal recorded the subagent's own exit; a turn the user stopped
	// before the signal stays stopped.
	for (const order of ["the signal, then the abort", "the abort, then the signal"] as const) {
		const restorable = order === "the signal, then the abort";
		it(`${restorable ? "keeps" : "leaves"} a subagent reply ended by ${order} ${restorable ? "restorable" : "as stopped"}`, async () => {
			const store = await openStore("@pi-session-exit-subagent-");
			const recorders: ((reason: postmortem.Reason) => void | Promise<void>)[] = [];
			const register = postmortem.register;
			vi.spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
				if (!id.startsWith("agent-session:")) return register(id, callback, options);
				recorders.push(callback);
				return () => {};
			});
			const sessionManager = SessionManager.create(store.dir, store.dir);
			sessionManager.appendMessage({ role: "user", content: "say hi", timestamp: Date.now() });
			sessionManager.appendMessage({
				...pendingAssistant,
				content: [{ type: "text", text: "hi" }],
				stopReason: "stop",
			});
			const { reply, streaming } = store.streamingReply();
			const { session: subagent } = store.open(sessionManager, [reply]);
			const prompted = subagent.prompt("now tell a long story");
			await streaming;
			// The prompt persists from its own event handler, long before a real signal
			// lands mid-reply; `abort()` would drop it while still queued.
			const persisted = () =>
				sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user")
					.length === 2;
			while (!persisted()) await Bun.sleep(1);
			const signal = async () => {
				for (const recorder of recorders) await recorder(postmortem.Reason.SIGTERM);
			};
			if (restorable) await signal();
			await subagent.abort();
			if (!restorable) await signal();
			await prompted.catch(() => {});
			await subagent.dispose();
			session = undefined;

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			expect(await readSessionInfo(sessionFile)).toMatchObject({
				status: restorable ? "interrupted" : "aborted",
				restorable,
			});
			expect(await store.restores(sessionFile)).toBe(restorable);
		});
	}

	// The GUI's End session sends SIGINT and kills omp if it has not stopped within a grace period;
	// a crash or power loss can cut a teardown short too. The signal is recorded as it lands, so a
	// first prompt in a session already on disk (after /new, or resumed before any reply) reads as
	// the user's stop then, not as a prompt left for `omp --restore` to send again.
	for (const reason of [postmortem.Reason.SIGINT, postmortem.Reason.SIGTERM]) {
		const restorable = reason === postmortem.Reason.SIGTERM;
		it(`records ${reason} under a first prompt, so the file reads ${restorable ? "restorable" : "as stopped"} if omp dies right after`, async () => {
			const store = await openStore("@pi-session-exit-first-prompt-");
			const recorders: ((reason: postmortem.Reason) => void | Promise<void>)[] = [];
			const register = postmortem.register;
			vi.spyOn(postmortem, "register").mockImplementation((id, callback, options) => {
				if (!id.startsWith("agent-session:")) return register(id, callback, options);
				recorders.push(callback);
				return () => {};
			});
			const sessionManager = SessionManager.create(store.dir, store.dir);
			await sessionManager.newSession();
			const { reply, streaming } = store.streamingReply();
			const { session: activeSession } = store.open(sessionManager, [reply]);
			const prompted = activeSession.prompt("tell a long story");
			await streaming;
			const prompt = () =>
				sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user");
			while (!prompt()) await Bun.sleep(1);
			// The signal lands, and omp is killed before its teardown gets any further.
			for (const recorder of recorders) await recorder(reason);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a session file path");
			expect(await readSessionInfo(sessionFile)).toMatchObject({ status: "pending", restorable });
			await activeSession.abort();
			await prompted.catch(() => {});
		});
	}

	// Resuming a session whose turn a signal ended before its teardown could close it closes it as
	// that teardown would have: a SIGINT is the user's stop, which `omp --restore` leaves alone, and
	// a SIGTERM cut it off, so restore goes on with it. Either way the call left running gets a result.
	for (const reason of [postmortem.Reason.SIGINT, postmortem.Reason.SIGTERM]) {
		const restorable = reason === postmortem.Reason.SIGTERM;
		it(`closes a tool call ${reason} left running as ${restorable ? "cut off" : "stopped by the user"} on resume`, () => {
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
			sessionManager.appendMessage(pendingAssistant);
			sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
				reason,
				kind: "signal",
				recordedAt: "2026-07-11T02:20:08.800Z",
				pendingToolCalls: [{ toolCallId: "toolu_repro", toolName: "bash" }],
			});

			const branch = sessionManager.getBranch();
			const closing = createInterruptedTurnAbortMessage(branch);
			expect(closing).toMatchObject({
				role: "assistant",
				stopReason: "aborted",
				errorMessage: restorable ? INTERRUPTED_TURN_ERROR : USER_INTERRUPT_LABEL,
			});
			for (const result of createInterruptedToolResults(branch)) sessionManager.appendMessage(result);
			sessionManager.appendMessage(closing!);
			expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
			expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
			expect(hasRestorableTurn(sessionManager.getBranch())).toBe(restorable);
		});
	}

	// `interrupted` and `pending` also cover turns `omp --restore` has nothing to go on
	// with; `restorable` tells them apart, as the listing reads them from disk.
	it("lists whether omp --restore goes on with a session, past its status", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-listing-");
		const call = { type: "toolCall" as const, id: "toolu_cut", name: "bash", arguments: { command: "ls" } };
		const prompt = { role: "user" as const, content: "list the files", timestamp: Date.now() };
		const signalExit = { reason: "sigterm", kind: "signal", recordedAt: "2026-07-11T02:20:08.800Z" };
		const normalExit = { reason: "dispose", kind: "normal", recordedAt: "2026-07-11T02:20:08.800Z" };
		// What a signal mid-tool records, before its teardown aborts the tool and the reply.
		const pendingToolCalls = [{ toolCallId: call.id, toolName: call.name }];
		const sigintExit = { ...signalExit, reason: "sigint" };
		const sigintMidTool = { ...sigintExit, pendingToolCalls };
		const sigtermMidTool = { ...signalExit, pendingToolCalls };
		const toolUse = { ...pendingAssistant, content: [call], stopReason: "toolUse" as const };
		const abortedResult: Message = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "Command aborted" }],
			isError: true,
			timestamp: Date.now(),
		};
		const answered = {
			...pendingAssistant,
			content: [{ type: "text" as const, text: "done" }],
			stopReason: "stop" as const,
		};
		const cases: {
			name: string;
			entries: (["message", Message] | ["exit", object])[];
			status: string;
			restorable: boolean;
		}[] = [
			{
				// The user pressed Esc after the reply's tool calls streamed.
				name: "stopped by the user",
				entries: [
					["message", prompt],
					[
						"message",
						{ ...pendingAssistant, content: [call], stopReason: "aborted", errorMessage: "Interrupted by user" },
					],
					["message", createSyntheticToolResultMessage(call, "aborted", "Interrupted by user")],
				],
				status: "interrupted",
				restorable: false,
			},
			{
				// A signal cut the reply off after its tool calls streamed.
				name: "cut off by a signal",
				entries: [
					["message", prompt],
					["exit", signalExit],
					[
						"message",
						{ ...pendingAssistant, content: [call], stopReason: "aborted", errorMessage: INTERRUPTED_TURN_ERROR },
					],
					["message", createSyntheticToolResultMessage(call, "aborted", INTERRUPTED_TURN_ERROR)],
				],
				status: "interrupted",
				restorable: true,
			},
			{
				// The session was reopened and ended (SIGINT) with nothing running: like
				// quitting it, the user left the turn as it was.
				name: "cut off by a signal, then reopened and ended",
				entries: [
					["message", prompt],
					["exit", signalExit],
					[
						"message",
						{ ...pendingAssistant, content: [call], stopReason: "aborted", errorMessage: INTERRUPTED_TURN_ERROR },
					],
					["message", createSyntheticToolResultMessage(call, "aborted", INTERRUPTED_TURN_ERROR)],
					["exit", sigintExit],
				],
				status: "interrupted",
				restorable: false,
			},
			{
				// A server stop of the reopened session is not the user's choice.
				name: "cut off by a signal, then reopened and cut off again",
				entries: [
					["message", prompt],
					["exit", signalExit],
					[
						"message",
						{ ...pendingAssistant, content: [call], stopReason: "aborted", errorMessage: INTERRUPTED_TURN_ERROR },
					],
					["message", createSyntheticToolResultMessage(call, "aborted", INTERRUPTED_TURN_ERROR)],
					["exit", signalExit],
				],
				status: "interrupted",
				restorable: true,
			},
			{
				// End session (SIGINT) mid-tool, and omp was killed before its teardown wrote
				// anything more: restore would run the command the user stopped again.
				name: "stopped by SIGINT, then killed",
				entries: [
					["message", prompt],
					["message", toolUse],
					["exit", sigintMidTool],
				],
				status: "interrupted",
				restorable: false,
			},
			{
				name: "cut off by SIGTERM, then killed",
				entries: [
					["message", prompt],
					["message", toolUse],
					["exit", sigtermMidTool],
				],
				status: "interrupted",
				restorable: true,
			},
			{
				// The teardown saved the aborted tool's result, not yet the reply it aborted.
				name: "stopped by SIGINT, then killed during its teardown",
				entries: [
					["message", prompt],
					["message", toolUse],
					["exit", sigintMidTool],
					["message", abortedResult],
				],
				status: "interrupted",
				restorable: false,
			},
			{
				name: "stopped at the output limit",
				entries: [
					["message", prompt],
					["message", { ...answered, stopReason: "length" }],
				],
				status: "interrupted",
				restorable: false,
			},
			{
				name: "prompted, then quit",
				entries: [
					["message", prompt],
					["message", answered],
					["message", { ...prompt, content: "and the hidden ones" }],
					["exit", normalExit],
				],
				status: "pending",
				restorable: false,
			},
			{
				name: "prompted, then killed",
				entries: [
					["message", prompt],
					["message", answered],
					["message", { ...prompt, content: "and the hidden ones" }],
				],
				status: "pending",
				restorable: true,
			},
		];
		for (const [index, { name, entries, status, restorable }] of cases.entries()) {
			const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), String(index)));
			for (const [kind, value] of entries) {
				if (kind === "message") sessionManager.appendMessage(value);
				else sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, value);
			}
			await sessionManager.close();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			expect({ name, info: await readSessionInfo(sessionFile) }).toMatchObject({
				name,
				info: { status, restorable },
			});
		}
	});

	it("keeps the signal reason through an SDK session's dispose", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-sdk-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "say hi", timestamp: Date.now() });
		sessionManager.appendMessage({
			...pendingAssistant,
			content: [{ type: "text", text: "hi" }],
			stopReason: "stop",
		});
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});

		// The interactive teardown disposes the session the SDK built; the reason it
		// passes decides whether a turn in flight ends restorable.
		await created.session.dispose({ reason: postmortem.Reason.SIGTERM });

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const exitEntry = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		await reopened.close();
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({ reason: "sigterm", kind: "signal" });
	});

	it("does not materialize an empty session just to write an exit marker", async () => {
		tempDir = TempDir.createSync("@pi-empty-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file path");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await session.dispose();
		session = undefined;

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(
			sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE),
		).toBe(false);
	});

	it("treats assistant tool calls as pending even when stopReason is not toolUse", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");
	});

	it("clears the pending warning once the matching tool result is recorded", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
			startedAt: new Date().toISOString(),
		} satisfies ToolExecutionStartData);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs an abnormal process-exit tail as one terminal aborted assistant message", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "partial result stays in history" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const recovered = createInterruptedTurnAbortMessage(sessionManager.getBranch());
		expect(recovered).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
		expect(recovered?.errorMessage).toContain("process exited");

		sessionManager.appendMessage(recovered!);
		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(
					message =>
						message.role === "toolResult" &&
						message.content.some(part => part.type === "text" && part.text === "partial result stays in history"),
				),
		).toBe(true);
	});

	it("closes a turn cut off without an exit record only when --restore assumes the exit, until a normal exit follows", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		// SIGKILL or power loss: no session_exit was written.
		const crashed = sessionManager.getBranch();
		expect(createInterruptedTurnAbortMessage(crashed)).toBeUndefined();
		expect(hasRestorableTurn(crashed)).toBe(true);

		const closed = createInterruptedTurnAbortMessage(crashed, undefined, { assumeExit: true });
		expect(closed).toMatchObject({ role: "assistant", stopReason: "aborted", model: pendingAssistant.model });
		for (const result of createInterruptedToolResults(crashed)) sessionManager.appendMessage(result);
		sessionManager.appendMessage(closed!);
		expect(
			createInterruptedTurnAbortMessage(sessionManager.getBranch(), undefined, { assumeExit: true }),
		).toBeUndefined();
		// Closed but never retried: a later restore still goes on with it…
		expect(hasRestorableTurn(sessionManager.getBranch())).toBe(true);
		// …unless the user quit normally after seeing it interrupted.
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		expect(hasRestorableTurn(sessionManager.getBranch())).toBe(false);
	});

	it("reconstructs a normal exit that reports pending tool calls", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: [{ toolCallId: "toolu_repro", toolName: "bash" }],
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("ignores malformed pending tool diagnostics on normal exits", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: "not an array",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs an interrupted assistant tool-call tail", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("keeps an interrupted ask question in resumed model context without replaying completed calls", () => {
		const sessionManager = SessionManager.inMemory();
		const question = { questions: [{ question: "Deploy now?", options: ["Yes", "No"], recommended: "Yes" }] };
		sessionManager.appendMessage({ role: "user", content: "prepare deployment", timestamp: Date.now() });
		sessionManager.appendMessage({
			...pendingAssistant,
			content: [
				{ type: "toolCall", id: "toolu_done", name: "read", arguments: { path: "deploy.md" } },
				{ type: "toolCall", id: "toolu_ask", name: "ask", arguments: question },
			],
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_done",
			toolName: "read",
			content: [{ type: "text", text: "Deployment instructions" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_ask",
			toolName: "ask",
			startedAt: "2026-09-30T00:00:00.000Z",
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-09-30T00:00:01.000Z",
		});

		const branch = sessionManager.getBranch();
		const aborted = createInterruptedTurnAbortMessage(branch);
		expect(aborted).toBeDefined();
		for (const result of createInterruptedToolResults(branch)) sessionManager.appendMessage(result);
		sessionManager.appendMessage(aborted!);
		const context = sessionManager.buildSessionContext().messages;
		expect(context).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: expect.arrayContaining([
					expect.objectContaining({
						type: "toolCall",
						id: "toolu_ask",
						arguments: question,
					}),
				]),
			}),
		);
		expect(context.filter(message => message.role === "toolResult" && message.toolCallId === "toolu_ask")).toEqual([
			expect.objectContaining({
				isError: true,
				content: [expect.objectContaining({ text: expect.stringContaining("outcome is unknown") })],
			}),
		]);
		expect(
			context.filter(message => message.role === "toolResult" && message.toolCallId === "toolu_done"),
		).toHaveLength(1);
		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs tool-call content even when stopReason is stop", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("does not reconstruct a failed tool turn already closed by synthetic results", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "error" });
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "Tool execution stopped after model failure." }],
			isError: true,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs a first user-message tail with selected model metadata", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(
			createInterruptedTurnAbortMessage(sessionManager.getBranch(), {
				api: pendingAssistant.api,
				provider: pendingAssistant.provider,
				model: pendingAssistant.model,
			}),
		).toMatchObject({
			role: "assistant",
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("does not reconstruct clean, completed, or superseded exits", () => {
		const normalExit = SessionManager.inMemory();
		normalExit.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		normalExit.appendMessage(pendingAssistant);
		normalExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const completedTurn = SessionManager.inMemory();
		completedTurn.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		completedTurn.appendMessage({
			...pendingAssistant,
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		});
		completedTurn.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const supersededExit = SessionManager.inMemory();
		supersededExit.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
		supersededExit.appendMessage(pendingAssistant);
		supersededExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		supersededExit.appendMessage({ role: "user", content: "new turn", timestamp: Date.now() });

		expect(createInterruptedTurnAbortMessage(normalExit.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(completedTurn.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(supersededExit.getBranch())).toBeUndefined();
	});
});
