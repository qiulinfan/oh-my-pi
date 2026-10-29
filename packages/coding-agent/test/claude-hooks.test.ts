/**
 * Claude Code declarative hooks (`.claude/settings.json` → `hooks`) run through the
 * built-in extension on omp's bus. Hooks are tiny shell scripts in a temp project;
 * every test drives the runner's emit* seams, never a model.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { invalidate } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { injectPluginDirRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { claudeMatcherMatches, createClaudeHooksExtension } from "@oh-my-pi/pi-coding-agent/extensibility/claude-hooks";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Harness {
	runner: ExtensionRunner;
	notes: { message: string; type?: string }[];
	approvals: string[];
	aborts: number;
}

describe("Claude Code hooks extension", () => {
	let shared: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let temp: TempDir;
	let project: string;
	let home: string;
	let savedClaudeConfigDir: string | undefined;

	beforeAll(async () => {
		shared = TempDir.createSync("@omp-claude-hooks-shared-");
		authStorage = await AuthStorage.create(path.join(shared.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		shared.removeSync();
	});

	beforeEach(async () => {
		// The user's real Claude config must never leak into these sessions.
		savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		temp = TempDir.createSync("@omp-claude-hooks-");
		project = temp.join("project");
		home = temp.join("home");
		await fs.mkdir(path.join(project, ".claude"), { recursive: true });
		await fs.mkdir(home, { recursive: true });
	});

	afterEach(() => {
		if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
		temp.removeSync();
	});

	/** Write an executable `/bin/sh` script under the temp dir and return its path. */
	async function script(name: string, body: string): Promise<string> {
		const file = temp.join("scripts", name);
		await Bun.write(file, `#!/bin/sh\n${body}\n`);
		await fs.chmod(file, 0o755);
		return file;
	}

	async function writeSettings(hooks: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
		const file = path.join(project, ".claude", "settings.json");
		await Bun.write(file, JSON.stringify({ ...extra, hooks }));
		// Discovery caches file contents; a rewrite in the same process must be re-read, as after an edit.
		invalidate(file);
	}

	function group(command: string, matcher?: string, timeout?: number): Record<string, unknown> {
		return {
			...(matcher === undefined ? {} : { matcher }),
			hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }],
		};
	}

	async function harness(
		options: { settings?: Record<string, unknown>; ui?: boolean; approve?: "once" | "deny" } = {},
	): Promise<Harness> {
		const settings = Settings.isolated(options.settings ?? {});
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			createClaudeHooksExtension({ settings, cwd: project, home }),
			project,
			new EventBus(),
			runtime,
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			project,
			SessionManager.inMemory(project),
			modelRegistry,
			undefined,
			settings,
		);
		const state: Harness = { runner, notes: [], approvals: [], aborts: 0 };
		const notify: ExtensionUIContext["notify"] = (message, type) => {
			state.notes.push({ message, type });
		};
		const approve: NonNullable<ExtensionUIContext["approve"]> = async prompt => {
			state.approvals.push(prompt.full);
			return options.approve ?? "deny";
		};
		const ui: ExtensionUIContext = Object.create(
			Object.create(runner.getUIContext(), { notify: { value: notify }, approve: { value: approve } }),
		);
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {
					state.aborts++;
				},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			options.ui === false ? undefined : ui,
			options.ui === false ? "print" : "tui",
		);
		return state;
	}

	const bashCall = (command: string) =>
		({ type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command } }) as const;

	it("blocks a PreToolUse call on exit 2 with stderr as the reason and hands the hook Claude Code's payload", async () => {
		const payloadFile = temp.join("payload.json");
		const guard = await script(
			"guard.sh",
			`cat > "${payloadFile}"\nprintf 'project=%s\\n' "$CLAUDE_PROJECT_DIR" >> "${payloadFile}.env"\necho "rm is not allowed here" >&2\nexit 2`,
		);
		await writeSettings({ PreToolUse: [group(guard, "Bash")] });
		const { runner } = await harness();

		const result = await runner.emitToolCall(bashCall("rm -rf build"));

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("rm is not allowed here");
		const payload = JSON.parse(await Bun.file(payloadFile).text());
		expect(payload).toMatchObject({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "rm -rf build" },
			tool_use_id: "call-1",
			cwd: project,
		});
		expect(typeof payload.session_id).toBe("string");
		expect(await Bun.file(`${payloadFile}.env`).text()).toBe(`project=${project}\n`);
	});

	it("applies JSON permission decisions: deny blocks, allow rewrites input through updatedInput", async () => {
		const deny = await script(
			"deny.sh",
			`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"writes to .env are forbidden"}}'`,
		);
		const rewrite = await script(
			"rewrite.sh",
			`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"file_path":"notes/safe.txt"}}}'`,
		);
		await writeSettings({ PreToolUse: [group(deny, "Bash"), group(rewrite, "Write")] });
		const { runner, approvals } = await harness();

		const denied = await runner.emitToolCall(bashCall("cat .env"));
		expect(denied?.block).toBe(true);
		expect(denied?.reason).toContain("writes to .env are forbidden");

		const allowed = await runner.emitToolCall({
			type: "tool_call",
			toolName: "write",
			toolCallId: "call-2",
			input: { path: "notes/a.txt", content: "x" },
		});
		expect(allowed?.block).toBeUndefined();
		// Claude Code's `file_path` maps back onto omp's `path`; the alias never reaches the tool.
		expect(allowed?.input).toEqual({ path: "notes/safe.txt", content: "x" });
		// "allow" adds no prompt of its own; omp's approval gate still decides afterwards.
		expect(approvals).toEqual([]);
	});

	it("routes an ask decision into the approval prompt and blocks when it is refused or no UI exists", async () => {
		const ask = await script(
			"ask.sh",
			`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"touches production"}}'`,
		);
		await writeSettings({ PreToolUse: [group(ask, "Bash")] });

		const refused = await harness({ approve: "deny" });
		const refusedResult = await refused.runner.emitToolCall(bashCall("deploy"));
		expect(refused.approvals).toHaveLength(1);
		expect(refused.approvals[0]).toContain("touches production");
		expect(refusedResult?.block).toBe(true);

		const approved = await harness({ approve: "once" });
		expect(await approved.runner.emitToolCall(bashCall("deploy"))).toBeUndefined();
		expect(approved.approvals).toHaveLength(1);

		const headless = await harness({ ui: false });
		const headlessResult = await headless.runner.emitToolCall(bashCall("deploy"));
		expect(headlessResult?.block).toBe(true);
		expect(headlessResult?.reason).toContain("no interactive UI");
	});

	it("matches tool names with Claude Code matcher semantics and omp-to-Claude name mapping", async () => {
		const block = await script("block.sh", `echo blocked >&2\nexit 2`);
		await writeSettings({ PreToolUse: [group(block, "^(Write|Edit)$"), group(block, "WebFetch")] });
		const { runner } = await harness();

		expect(await runner.emitToolCall(bashCall("ls"))).toBeUndefined();
		const write = await runner.emitToolCall({
			type: "tool_call",
			toolName: "write",
			toolCallId: "w",
			input: { path: "a.txt", content: "" },
		});
		expect(write?.block).toBe(true);
		// `read` of a URL is Claude Code's WebFetch; a file read is Read and stays unmatched.
		const fetch = await runner.emitToolCall({
			type: "tool_call",
			toolName: "read",
			toolCallId: "r1",
			input: { path: "https://example.com/" },
		});
		expect(fetch?.block).toBe(true);
		const fileRead = await runner.emitToolCall({
			type: "tool_call",
			toolName: "read",
			toolCallId: "r2",
			input: { path: "a.txt" },
		});
		expect(fileRead).toBeUndefined();

		// Exact lists stay exact; anything else is an unanchored regex.
		expect(claudeMatcherMatches("Edit|Write", "NotebookEdit")).toBe(false);
		expect(claudeMatcherMatches("Edit.*", "NotebookEdit")).toBe(true);
		expect(claudeMatcherMatches("*", "anything")).toBe(true);
	});

	it("passes the tool response to PostToolUse and feeds exit-2 stderr back to the model", async () => {
		const payloadFile = temp.join("post.json");
		const post = await script("post.sh", `cat > "${payloadFile}"\necho "lint failed: missing semicolon" >&2\nexit 2`);
		await writeSettings({ PostToolUse: [group(post, "Bash")] });
		const { runner, notes } = await harness();

		const result = await runner.emitToolResult({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "call-3",
			input: { command: "echo hi" },
			content: [{ type: "text", text: "hi" }],
			isError: false,
			details: undefined,
		});

		const payload = JSON.parse(await Bun.file(payloadFile).text());
		expect(payload).toMatchObject({
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "echo hi" },
			tool_response: { stdout: "hi" },
		});
		expect(result?.additionalContext).toContain("lint failed: missing semicolon");
		expect(notes.some(note => note.message.includes("lint failed"))).toBe(true);
	});

	it("adds UserPromptSubmit stdout as context for the prompt and blocks the prompt on exit 2", async () => {
		const context = await script("context.sh", `echo "Sprint ends Friday"`);
		await writeSettings({ UserPromptSubmit: [group(context)] });
		const { runner } = await harness();

		expect(await runner.emitInput("plan the release", undefined, "interactive")).toEqual({});
		const start = await runner.emitBeforeAgentStart("plan the release", undefined, []);
		const message = start?.messages?.[0];
		expect(message && typeof message === "object" ? message.content : undefined).toContain("Sprint ends Friday");

		const reject = await script("reject.sh", `echo "prompt mentions a secret" >&2\nexit 2`);
		await writeSettings({ UserPromptSubmit: [group(reject)] });
		const blocking = await harness();
		expect(await blocking.runner.emitInput("my token is abc", undefined, "interactive")).toEqual({ handled: true });
		expect(blocking.notes.some(note => note.type === "error" && note.message.includes("secret"))).toBe(true);
	});

	it("keeps the agent going when a Stop hook exits 2 and lets it stop on exit 0", async () => {
		const payloadFile = temp.join("stop.json");
		const keepGoing = await script("stop.sh", `cat > "${payloadFile}"\necho "tests are still failing" >&2\nexit 2`);
		await writeSettings({ Stop: [group(keepGoing)] });
		const { runner } = await harness();

		const result = await runner.emitSessionStop({
			messages: [],
			turn_id: 0,
			session_id: "s",
			stop_hook_active: false,
			signal: new AbortController().signal,
		});
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("tests are still failing");
		expect(JSON.parse(await Bun.file(payloadFile).text())).toMatchObject({
			hook_event_name: "Stop",
			stop_hook_active: false,
		});

		const done = await script("done.sh", "exit 0");
		await writeSettings({ Stop: [group(done)] });
		const finishing = await harness();
		expect(
			await finishing.runner.emitSessionStop({
				messages: [],
				turn_id: 0,
				session_id: "s",
				stop_hook_active: true,
				signal: new AbortController().signal,
			}),
		).toBeUndefined();
	});

	it("treats a hook that outlives its timeout as a non-blocking error", async () => {
		const slow = await script("slow.sh", `sleep 5\nexit 2`);
		await writeSettings({ PreToolUse: [group(slow, "Bash", 0.3)] });
		const { runner, notes } = await harness();

		const started = performance.now();
		const result = await runner.emitToolCall(bashCall("ls"));

		expect(result).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(3000);
		expect(notes.some(note => note.type === "warning" && note.message.includes("timed out"))).toBe(true);
	});

	it("stops the session on continue:false and runs nothing when disabled", async () => {
		const halt = await script("halt.sh", `echo '{"continue":false,"stopReason":"budget exhausted"}'`);
		await writeSettings({ PreToolUse: [group(halt)] });

		const active = await harness();
		const halted = await active.runner.emitToolCall(bashCall("ls"));
		expect(halted?.block).toBe(true);
		expect(active.aborts).toBe(1);
		expect(active.notes.some(note => note.message.includes("budget exhausted"))).toBe(true);

		const disabled = await harness({ settings: { "claudeHooks.enabled": false } });
		expect(disabled.runner.hasHandlers("tool_call")).toBe(false);
		expect(await disabled.runner.emitToolCall(bashCall("ls"))).toBeUndefined();

		await writeSettings({ PreToolUse: [group(halt)] }, { disableAllHooks: true });
		const optedOut = await harness();
		expect(await optedOut.runner.emitToolCall(bashCall("ls"))).toBeUndefined();
	});

	it("cancels compaction when a PreCompact hook blocks", async () => {
		const payloadFile = temp.join("compact.json");
		const keep = await script("keep.sh", `cat > "${payloadFile}"\necho "save notes first" >&2\nexit 2`);
		await writeSettings({ PreCompact: [group(keep, "manual")] });
		const { runner } = await harness();

		const result = await runner.emit({
			type: "session_before_compact",
			preparation: {} as never,
			branchEntries: [],
			customInstructions: "keep the API notes",
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ cancel: true });
		expect(JSON.parse(await Bun.file(payloadFile).text())).toMatchObject({
			trigger: "manual",
			custom_instructions: "keep the API notes",
		});
	});

	it("runs hooks declared in an enabled Claude Code plugin's hooks/hooks.json", async () => {
		const pluginDir = temp.join("plugin");
		await Bun.write(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "guard" }));
		await Bun.write(path.join(pluginDir, "scripts", "guard.sh"), `#!/bin/sh\necho "plugin says no" >&2\nexit 2\n`);
		await fs.chmod(path.join(pluginDir, "scripts", "guard.sh"), 0o755);
		await Bun.write(
			path.join(pluginDir, "hooks", "hooks.json"),
			JSON.stringify({
				hooks: { PreToolUse: [group(`\${CLAUDE_PLUGIN_ROOT}/scripts/guard.sh`, "Bash")] },
			}),
		);
		await injectPluginDirRoots(home, [pluginDir], project);
		try {
			const { runner } = await harness();
			const result = await runner.emitToolCall(bashCall("ls"));
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("plugin says no");
		} finally {
			await injectPluginDirRoots(home, [], project);
		}
	});
});
