/**
 * Claude Code declarative hooks, run as a built-in extension.
 *
 * Reads the `hooks` blocks of Claude Code's `settings.json` files and of enabled
 * Claude Code plugins' `hooks/hooks.json`, and runs each `type: "command"` hook on
 * the matching omp bus event with the JSON payload Claude Code sends on stdin.
 * Exit codes and JSON stdout follow Claude Code's contract (exit 2 blocks where
 * the event can block; other non-zero exits are non-blocking errors). See
 * `docs/claude-code-hooks.md` for the event and tool-name mapping.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { isRecord, logger, procmgr, prompt, ptree, tryParseJson } from "@oh-my-pi/pi-utils";
import { isProviderEnabled, isUserSourceEnabled } from "../capability";
import { readFile } from "../capability/fs";
import { resolveClaudePaths } from "../config/claude-paths";
import type { Settings } from "../config/settings";
import { legacyProviderAllowed } from "../discovery/agent-plugin-format";
import { type ClaudePluginRoot, listClaudePluginRoots } from "../discovery/helpers";
import { substitutePluginRoot } from "../discovery/substitute-plugin-root";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import { formatApprovalArguments, requestApproval } from "../tools/approval";
import messageTemplate from "./claude-hooks-message.md" with { type: "text" };
import { EXTENSION_HANDLER_TIMEOUT_MS, SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS } from "./extensions/runner";
import type { ExtensionContext, ExtensionFactory, ToolCallEventResult, ToolResultEvent } from "./extensions/types";
import { cfgClaudeHooksEnabled, cfgExtensionHandlersToolCallTimeoutMs } from "./settings";

/** Claude Code hook events omp has an equivalent bus event for. */
export const CLAUDE_HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SubagentStop",
	"SessionStart",
	"SessionEnd",
	"PreCompact",
	"Notification",
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/** One `type: "command"` hook as declared in a settings or plugin hooks file. */
export interface ClaudeCommandHook {
	/** Shell command, or the executable when `args` is present (exec form). */
	command: string;
	args?: string[];
	/** Declared `timeout`, in seconds. */
	timeoutSec?: number;
	/** File that declared the hook. */
	source: string;
	/** Plugin root for plugin hooks; exported as `CLAUDE_PLUGIN_ROOT`. */
	pluginRoot?: string;
}

interface ClaudeHookGroup {
	matcher?: string;
	hooks: ClaudeCommandHook[];
}

/** Hooks from every enabled source, grouped by event in declaration order. */
export interface ClaudeHookConfig {
	groups: Map<ClaudeHookEvent, ClaudeHookGroup[]>;
	warnings: string[];
	/** A settings file set `disableAllHooks: true`. */
	disabled: boolean;
}

/** omp built-in tool names that differ from Claude Code's; others pass through unchanged. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	glob: "Glob",
	find: "Glob",
	grep: "Grep",
	web_search: "WebSearch",
	task: "Task",
	todo: "TodoWrite",
	ask: "AskUserQuestion",
};

/** Tools whose `path` argument Claude Code calls `file_path` (`url` for a `read` of a URL). */
const PATH_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/** Claude Code's default command-hook timeout, in seconds. */
const DEFAULT_TIMEOUT_SEC = 600;
/** Claude Code's lower defaults for events that hold up the user. */
const EVENT_DEFAULT_TIMEOUT_SEC: Partial<Record<ClaudeHookEvent, number>> = {
	UserPromptSubmit: 30,
	SessionEnd: 1.5,
};
/**
 * Hooks stop this long before the omp handler budget ends, so a slow hook times out
 * here (a non-blocking error, as in Claude Code) and its process is killed, instead
 * of the runner abandoning the handler (which fails a `tool_call` closed).
 */
const HANDLER_BUDGET_MARGIN_MS = 500;
const NOTIFY_MAX_CHARS = 1000;
const MAX_PENDING_PROMPTS = 8;
const HOOK_CONTEXT_MESSAGE_TYPE = "claude-hook-context";

const EXACT_MATCHER = /^[A-Za-z0-9_\-\s,|]+$/;

function isClaudeHookEvent(value: string): value is ClaudeHookEvent {
	return (CLAUDE_HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Claude Code matcher semantics: absent, `""` or `"*"` match everything; a matcher of
 * only letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything
 * else is an unanchored JavaScript regular expression.
 */
export function claudeMatcherMatches(matcher: string | undefined, value: string): boolean {
	const trimmed = matcher?.trim() ?? "";
	if (trimmed === "" || trimmed === "*") return true;
	if (EXACT_MATCHER.test(trimmed)) return trimmed.split(/[|,]/).some(part => part.trim() === value);
	try {
		return new RegExp(trimmed).test(value);
	} catch {
		return false;
	}
}

function isUrl(value: unknown): value is string {
	return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** The name a Claude Code matcher sees for an omp tool call. */
export function claudeToolName(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "read" && isUrl(input.path)) return "WebFetch";
	return CLAUDE_TOOL_NAMES[toolName] ?? toolName;
}

function toClaudeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	const out = { ...input };
	if (PATH_TOOLS.has(toolName) && typeof input.path === "string") {
		if (toolName === "read" && isUrl(input.path)) out.url = input.path;
		else out.file_path = input.path;
	}
	return out;
}

/** Merge a hook's `updatedInput` over the original arguments, mapping Claude Code aliases back. */
function fromClaudeToolInput(
	toolName: string,
	original: Record<string, unknown>,
	updated: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...original, ...updated };
	if (PATH_TOOLS.has(toolName)) {
		const alias = typeof updated.file_path === "string" ? updated.file_path : updated.url;
		if (typeof alias === "string") out.path = alias;
		delete out.file_path;
		delete out.url;
	}
	return out;
}

function toClaudeToolResponse(event: ToolResultEvent): Record<string, unknown> {
	const text = event.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
	if (event.toolName === "bash") return { stdout: text, stderr: "", interrupted: false, isImage: false };
	const response: Record<string, unknown> = { output: text, success: true };
	if (PATH_TOOLS.has(event.toolName) && typeof event.input.path === "string") {
		if (isUrl(event.input.path)) response.url = event.input.path;
		else response.filePath = event.input.path;
	}
	return response;
}

function messageText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(text => text.length > 0)
		.join("\n");
}

// =============================================================================
// Configuration
// =============================================================================

function parseHooksBlock(
	block: unknown,
	source: string,
	pluginRoot: string | undefined,
	config: ClaudeHookConfig,
	seen: Set<string> | undefined,
): void {
	if (!isRecord(block)) {
		config.warnings.push(`${source}: "hooks" must be an object`);
		return;
	}
	for (const [event, entries] of Object.entries(block)) {
		if (!isClaudeHookEvent(event)) {
			config.warnings.push(`${source}: ${event} hooks have no omp equivalent and do not run`);
			continue;
		}
		if (!Array.isArray(entries)) {
			config.warnings.push(`${source}: ${event} must be an array of matcher groups`);
			continue;
		}
		for (const entry of entries) {
			if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
				config.warnings.push(`${source}: ${event} entry needs a "hooks" array`);
				continue;
			}
			const matcher = typeof entry.matcher === "string" ? entry.matcher : undefined;
			if (matcher !== undefined && !EXACT_MATCHER.test(matcher.trim()) && matcher.trim() !== "*") {
				try {
					new RegExp(matcher.trim());
				} catch {
					config.warnings.push(`${source}: ${event} matcher ${JSON.stringify(matcher)} is not a valid regex`);
					continue;
				}
			}
			const hooks: ClaudeCommandHook[] = [];
			for (const hook of entry.hooks) {
				if (!isRecord(hook)) continue;
				if (hook.type !== "command") {
					config.warnings.push(
						`${source}: ${event} hook type ${JSON.stringify(hook.type)} is not supported; only "command" hooks run`,
					);
					continue;
				}
				if (typeof hook.command !== "string" || hook.command.trim() === "") {
					config.warnings.push(`${source}: ${event} command hook has no command`);
					continue;
				}
				let command = hook.command;
				let args =
					Array.isArray(hook.args) && hook.args.every(arg => typeof arg === "string")
						? (hook.args as string[])
						: undefined;
				if (pluginRoot) {
					command = substitutePluginRoot(command, pluginRoot);
					args = args && substitutePluginRoot(args, pluginRoot);
				}
				if (seen) {
					const key = JSON.stringify([event, matcher ?? "", command, args ?? null]);
					if (seen.has(key)) continue;
					seen.add(key);
				}
				const timeoutSec = typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : undefined;
				hooks.push({ command, args, timeoutSec, source, pluginRoot });
			}
			if (hooks.length === 0) continue;
			const groups = config.groups.get(event) ?? [];
			groups.push({ matcher, hooks });
			config.groups.set(event, groups);
		}
	}
}

async function readJsonObject(file: string, config: ClaudeHookConfig): Promise<Record<string, unknown> | null> {
	const content = await readFile(file);
	if (content === null) return null;
	const data = tryParseJson<unknown>(content);
	if (!isRecord(data)) {
		config.warnings.push(`Failed to parse JSON in ${file}`);
		return null;
	}
	return data;
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function loadPluginHooks(cwd: string, home: string, config: ClaudeHookConfig): Promise<void> {
	let roots: ClaudePluginRoot[];
	try {
		({ roots } = await listClaudePluginRoots(home, cwd));
	} catch (error) {
		config.warnings.push(`Claude Code plugins: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	// Same admission rule as the claude-plugins discovery provider.
	const userEnabled = isUserSourceEnabled("claude-plugins") || isUserSourceEnabled("claude");
	for (const root of roots) {
		if (!userEnabled && root.scope !== "project" && root.origin === "claude") continue;
		if (!(await legacyProviderAllowed(root.path, "other"))) continue;
		const files = new Set([path.join(root.path, "hooks", "hooks.json")]);
		const manifest = await readJsonObject(path.join(root.path, ".claude-plugin", "plugin.json"), config);
		const declared = manifest?.hooks;
		if (typeof declared === "string" || Array.isArray(declared)) {
			for (const entry of [declared].flat()) {
				if (typeof entry !== "string") continue;
				const file = path.resolve(root.path, substitutePluginRoot(entry, root.path));
				if (isWithin(root.path, file)) files.add(file);
				else config.warnings.push(`${root.id}: hooks path ${entry} is outside the plugin`);
			}
		} else if (isRecord(declared)) {
			const block = isRecord(declared.hooks) ? declared.hooks : declared;
			parseHooksBlock(block, path.join(root.path, ".claude-plugin", "plugin.json"), root.path, config, undefined);
		}
		for (const file of files) {
			const data = await readJsonObject(file, config);
			if (data?.hooks !== undefined) parseHooksBlock(data.hooks, file, root.path, config, undefined);
		}
	}
}

/**
 * Load the Claude Code hooks that apply to `cwd`: `~/.claude/settings.json` when omp
 * reads `~/.claude` (the `claude` user source is opted in), the project's
 * `.claude/settings.json` and `.claude/settings.local.json`, and the hooks files of
 * Claude Code plugins omp discovers. Identical hooks declared in several settings
 * files run once; plugin hooks stay separate.
 */
export async function loadClaudeHookConfig(cwd: string, home: string = os.homedir()): Promise<ClaudeHookConfig> {
	const config: ClaudeHookConfig = { groups: new Map(), warnings: [], disabled: false };
	if (isProviderEnabled("claude")) {
		const userDir = resolveClaudePaths(home).configDir;
		const userEnabled = isUserSourceEnabled("claude");
		const files: string[] = [];
		if (userEnabled) files.push(path.join(userDir, "settings.json"));
		const projectDir = path.join(cwd, ".claude");
		// A session started in the home directory must not read ~/.claude through the project path.
		if (userEnabled || path.resolve(projectDir) !== path.resolve(userDir)) {
			const projectFiles = [path.join(projectDir, "settings.json"), path.join(projectDir, "settings.local.json")];
			for (const file of projectFiles) if (!files.includes(file)) files.push(file);
		}
		const seen = new Set<string>();
		for (const file of files) {
			const data = await readJsonObject(file, config);
			if (!data) continue;
			if (data.disableAllHooks === true) config.disabled = true;
			if (data.hooks !== undefined) parseHooksBlock(data.hooks, file, undefined, config, seen);
		}
	}
	if (isProviderEnabled("claude-plugins")) await loadPluginHooks(cwd, home, config);
	return config;
}

// =============================================================================
// Execution
// =============================================================================

interface HookOutcome {
	hook: ClaudeCommandHook;
	/** `success`: exit 0; `block`: exit 2; `error`: anything else (non-blocking). */
	status: "success" | "block" | "error";
	/** Parsed JSON stdout of a successful hook. */
	json?: Record<string, unknown>;
	/** Plain stdout of a successful hook, or stderr of a blocking one. */
	text: string;
	/** What went wrong, for an `error`. */
	detail?: string;
}

function expandProjectVars(value: string, vars: Record<string, string>): string {
	return value.replace(
		/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT)\}|\$(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT)\b/g,
		(match, a, b) => {
			return vars[(a ?? b) as string] ?? match;
		},
	);
}

async function runCommandHook(
	hook: ClaudeCommandHook,
	payload: Record<string, unknown>,
	cwd: string,
	settings: Settings,
	timeoutMs: number,
): Promise<HookOutcome> {
	const vars: Record<string, string> = { CLAUDE_PROJECT_DIR: cwd };
	if (hook.pluginRoot) vars.CLAUDE_PLUGIN_ROOT = hook.pluginRoot;
	let argv: string[];
	let env: Record<string, string>;
	try {
		const shell = settings.getShellConfig();
		if (hook.args) {
			argv = [expandProjectVars(hook.command, vars), ...hook.args.map(arg => expandProjectVars(arg, vars))];
		} else if (procmgr.isPosixShell(shell.shell)) {
			// Non-login: profile output would corrupt a hook's JSON stdout.
			argv = [shell.shell, "-c", hook.command];
		} else {
			argv = [shell.shell, ...shell.args, hook.command];
		}
		env = { ...shell.env, ...NON_INTERACTIVE_ENV, ...vars };
	} catch (error) {
		return { hook, status: "error", text: "", detail: error instanceof Error ? error.message : String(error) };
	}
	try {
		const result = await ptree.exec(argv, {
			cwd,
			env,
			input: JSON.stringify(payload),
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
		});
		if (result.exitError instanceof ptree.TimeoutError) {
			return { hook, status: "error", text: "", detail: `timed out after ${formatSeconds(timeoutMs)}` };
		}
		if (result.exitCode === 0) {
			const trimmed = result.stdout.trim();
			const json = trimmed.startsWith("{") ? tryParseJson<unknown>(trimmed) : null;
			return isRecord(json)
				? { hook, status: "success", json, text: "" }
				: { hook, status: "success", text: trimmed };
		}
		if (result.exitCode === 2) return { hook, status: "block", text: result.stderr.trim() };
		const stderr = result.stderr.trim();
		const detail = result.exitCode === null ? "was killed" : `exited with code ${result.exitCode}`;
		return { hook, status: "error", text: "", detail: stderr ? `${detail}: ${stderr}` : detail };
	} catch (error) {
		return { hook, status: "error", text: "", detail: error instanceof Error ? error.message : String(error) };
	}
}

function formatSeconds(ms: number): string {
	return `${Number((ms / 1000).toFixed(1))}s`;
}

function forDisplay(text: string): string {
	const clean = replaceTabs(text).trim();
	return clean.length > NOTIFY_MAX_CHARS ? `${clean.slice(0, NOTIFY_MAX_CHARS)}…` : clean;
}

function commandLabel(hook: ClaudeCommandHook): string {
	return forDisplay([hook.command, ...(hook.args ?? [])].join(" ")).split("\n")[0] ?? "";
}

/** Model-visible text attributed to a hook. */
function hookMessage(label: string, verb: string, text: string): string {
	return prompt.render(messageTemplate, { label, verb, text });
}

function hookSpecificOutput(outcome: HookOutcome): Record<string, unknown> | undefined {
	const output = outcome.json?.hookSpecificOutput;
	return isRecord(output) ? output : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `continue: false` from any hook: the `stopReason` (or a default) to show the user. */
function stopRequest(outcomes: readonly HookOutcome[], label: string): string | undefined {
	for (const outcome of outcomes) {
		if (outcome.json?.continue === false) {
			return stringField(outcome.json, "stopReason") ?? `${label} hook stopped the session`;
		}
	}
	return undefined;
}

/** Blocking reasons: exit-2 stderr and JSON `decision: "block"` reasons. */
function blockReasons(outcomes: readonly HookOutcome[], label: string): string[] {
	const reasons: string[] = [];
	for (const outcome of outcomes) {
		if (outcome.status === "block") {
			reasons.push(outcome.text || `${label} hook (${commandLabel(outcome.hook)}) blocked with no stderr`);
		} else if (outcome.json?.decision === "block") {
			reasons.push(stringField(outcome.json, "reason") ?? `${label} hook (${commandLabel(outcome.hook)}) blocked`);
		}
	}
	return reasons;
}

function additionalContexts(outcomes: readonly HookOutcome[], includePlainStdout: boolean): string[] {
	const contexts: string[] = [];
	for (const outcome of outcomes) {
		if (outcome.status !== "success") continue;
		const context = stringField(hookSpecificOutput(outcome), "additionalContext");
		if (context) contexts.push(context);
		else if (includePlainStdout && !outcome.json && outcome.text) contexts.push(outcome.text);
	}
	return contexts;
}

// =============================================================================
// Extension
// =============================================================================

export interface ClaudeHooksExtensionOptions {
	/** The session's settings: `claudeHooks.enabled`, the shell, and the tool_call handler budget. */
	settings: Settings;
	/** Session working directory whose hooks are loaded when the extension binds. */
	cwd: string;
	/** Home directory for `~/.claude`; defaults to `os.homedir()`. */
	home?: string;
}

interface PendingPrompt {
	text: string;
	contexts: string[];
}

/**
 * Built-in extension that runs Claude Code command hooks on omp's bus:
 * `tool_call` → PreToolUse, `tool_result` → PostToolUse, `input`/`before_agent_start`
 * → UserPromptSubmit, `session_stop` → Stop, subagent `agent_end` → SubagentStop,
 * `session_start`/`session_switch`/`session_compact` → SessionStart,
 * `session_shutdown`/`session_before_switch` → SessionEnd, `session_before_compact`
 * → PreCompact, `tool_approval_requested` → Notification.
 */
export function createClaudeHooksExtension(options: ClaudeHooksExtensionOptions): ExtensionFactory {
	const { settings } = options;
	const home = options.home ?? os.homedir();

	return async pi => {
		// Hooks are snapshotted when the session starts, as in Claude Code. A session
		// without any registers no handlers, so it pays nothing on the hot paths.
		if (!cfgClaudeHooksEnabled.get(settings)) return;
		const initial = await loadClaudeHookConfig(options.cwd, home);
		if (initial.warnings.length > 0) logger.warn("Claude Code hooks configuration", { warnings: initial.warnings });
		const events = initial.disabled ? new Set<ClaudeHookEvent>() : new Set(initial.groups.keys());
		if (events.size === 0 && initial.warnings.length === 0) return;

		let loaded: { cwd: string; config: Promise<ClaudeHookConfig> } = {
			cwd: options.cwd,
			config: Promise.resolve(initial),
		};
		let autoCompactionPending = false;
		let pendingPrompts: PendingPrompt[] = [];
		let pendingSessionContexts: string[] = [];

		const enabled = (): boolean => cfgClaudeHooksEnabled.get(settings);

		const showWarnings = (ctx: ExtensionContext, warnings: readonly string[]): void => {
			if (warnings.length > 0) ctx.ui.notify(forDisplay(`Claude Code hooks:\n${warnings.join("\n")}`), "warning");
		};

		/** The snapshot for the session's cwd; a moved session (`/move`) reloads once. */
		const configFor = (ctx: ExtensionContext): Promise<ClaudeHookConfig> => {
			if (loaded.cwd === ctx.cwd) return loaded.config;
			const config = loadClaudeHookConfig(ctx.cwd, home).then(result => {
				if (result.warnings.length > 0)
					logger.warn("Claude Code hooks configuration", { warnings: result.warnings });
				showWarnings(ctx, result.warnings);
				return result;
			});
			loaded = { cwd: ctx.cwd, config };
			return config;
		};

		const toolCallBudgetMs = (): number => {
			const value = cfgExtensionHandlersToolCallTimeoutMs.get(settings);
			return Number.isFinite(value) && value > 0 ? value : EXTENSION_HANDLER_TIMEOUT_MS;
		};

		/** Run the event's matching hooks in parallel and report non-blocking failures. */
		const runHooks = async (
			ctx: ExtensionContext,
			event: ClaudeHookEvent,
			matchValue: string | undefined,
			fields: Record<string, unknown>,
			budgetMs: number = EXTENSION_HANDLER_TIMEOUT_MS,
		): Promise<HookOutcome[]> => {
			if (!enabled()) return [];
			const config = await configFor(ctx);
			if (config.disabled) return [];
			const hooks = (config.groups.get(event) ?? [])
				.filter(group => matchValue === undefined || claudeMatcherMatches(group.matcher, matchValue))
				.flatMap(group => group.hooks);
			if (hooks.length === 0) return [];
			const payload: Record<string, unknown> = {
				session_id: ctx.sessionManager.getSessionId(),
				transcript_path: ctx.sessionManager.getSessionFile() ?? "",
				cwd: ctx.cwd,
				hook_event_name: event,
				...(ctx.agent.kind === "sub" ? { agent_id: ctx.agent.id, agent_type: ctx.agent.name } : {}),
				...fields,
			};
			const capMs = Math.max(100, budgetMs - HANDLER_BUDGET_MARGIN_MS);
			const label = matchValue === undefined ? event : `${event}:${matchValue}`;
			const outcomes = await Promise.all(
				hooks.map(hook => {
					const timeoutSec = hook.timeoutSec ?? EVENT_DEFAULT_TIMEOUT_SEC[event] ?? DEFAULT_TIMEOUT_SEC;
					return runCommandHook(hook, payload, ctx.cwd, settings, Math.min(timeoutSec * 1000, capMs));
				}),
			);
			for (const outcome of outcomes) {
				if (outcome.status === "error") {
					const message = `${label} hook error (${commandLabel(outcome.hook)}): ${outcome.detail ?? "failed"}`;
					logger.warn("Claude Code hook failed", { event, source: outcome.hook.source, detail: outcome.detail });
					ctx.ui.notify(forDisplay(message), "warning");
				}
				const systemMessage = stringField(outcome.json, "systemMessage");
				if (systemMessage) ctx.ui.notify(forDisplay(`${label} hook: ${systemMessage}`), "warning");
			}
			return outcomes;
		};

		/** Exit-2 stderr is shown to the user for events that cannot block. */
		const reportNonBlocking = (ctx: ExtensionContext, label: string, outcomes: readonly HookOutcome[]): void => {
			for (const reason of blockReasons(outcomes, label)) {
				ctx.ui.notify(forDisplay(`${label} hook: ${reason}`), "warning");
			}
		};

		const sessionStart = async (ctx: ExtensionContext, source: string): Promise<void> => {
			if (ctx.agent.kind !== "main") return;
			const outcomes = await runHooks(ctx, "SessionStart", source, { source });
			reportNonBlocking(ctx, "SessionStart", outcomes);
			const contexts = additionalContexts(outcomes, true);
			if (contexts.length > 0) {
				pendingSessionContexts.push(hookMessage("SessionStart", "additional context", contexts.join("\n\n")));
			}
		};

		const sessionEnd = async (ctx: ExtensionContext, reason: string, budgetMs?: number): Promise<void> => {
			if (ctx.agent.kind !== "main") return;
			reportNonBlocking(ctx, "SessionEnd", await runHooks(ctx, "SessionEnd", reason, { reason }, budgetMs));
		};

		/** UserPromptSubmit: `blocked` holds the reason shown to the user. */
		const userPromptSubmit = async (
			ctx: ExtensionContext,
			text: string,
		): Promise<{ blocked?: string; contexts: string[] }> => {
			const outcomes = await runHooks(ctx, "UserPromptSubmit", undefined, { prompt: text });
			const stop = stopRequest(outcomes, "UserPromptSubmit");
			if (stop !== undefined) return { blocked: stop, contexts: [] };
			const reasons = blockReasons(outcomes, "UserPromptSubmit");
			if (reasons.length > 0) return { blocked: reasons.join("\n"), contexts: [] };
			const contexts = additionalContexts(outcomes, true);
			return {
				contexts:
					contexts.length > 0
						? [hookMessage("UserPromptSubmit", "additional context", contexts.join("\n\n"))]
						: [],
			};
		};

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.agent.kind === "main") showWarnings(ctx, initial.warnings);
			if (!events.has("SessionStart") || !enabled()) return;
			const resumed = ctx.sessionManager.getEntries().some(entry => entry.type === "message");
			await sessionStart(ctx, resumed ? "resume" : "startup");
		});

		if (events.has("SessionStart") || events.has("UserPromptSubmit")) {
			pi.on("session_switch", async (event, ctx) => {
				pendingPrompts = [];
				pendingSessionContexts = [];
				await sessionStart(ctx, event.reason === "new" ? "clear" : event.reason);
			});
		}

		if (events.has("SessionStart")) {
			pi.on("session_compact", async (_event, ctx) => {
				await sessionStart(ctx, "compact");
			});
		}

		if (events.has("SessionEnd")) {
			pi.on("session_before_switch", async (event, ctx) => {
				await sessionEnd(ctx, event.reason === "new" ? "clear" : event.reason === "resume" ? "resume" : "other");
			});
			pi.on("session_shutdown", async (_event, ctx) => {
				await sessionEnd(ctx, "other", SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
			});
		}

		if (events.has("PreCompact")) {
			pi.on("auto_compaction_start", () => {
				autoCompactionPending = true;
			});
			pi.on("auto_compaction_end", () => {
				autoCompactionPending = false;
			});
		}

		if (events.has("PreCompact"))
			pi.on("session_before_compact", async (event, ctx) => {
				const trigger = autoCompactionPending ? "auto" : "manual";
				const outcomes = await runHooks(ctx, "PreCompact", trigger, {
					trigger,
					custom_instructions: event.customInstructions ?? "",
				});
				const reasons = blockReasons(outcomes, "PreCompact");
				if (reasons.length === 0) return undefined;
				ctx.ui.notify(forDisplay(`PreCompact hook blocked compaction:\n${reasons.join("\n")}`), "warning");
				return { cancel: true };
			});

		if (events.has("UserPromptSubmit"))
			pi.on("input", async (event, ctx) => {
				if (ctx.agent.kind !== "main" || !enabled()) return undefined;
				// Slash and shell commands are not prompts; prompts they expand to reach before_agent_start.
				if (event.text.startsWith("/") || event.text.startsWith("!")) return undefined;
				const result = await userPromptSubmit(ctx, event.text);
				if (result.blocked !== undefined) {
					ctx.ui.notify(forDisplay(`UserPromptSubmit operation blocked by hook:\n${result.blocked}`), "error");
					return { handled: true };
				}
				pendingPrompts = [...pendingPrompts, { text: event.text, contexts: result.contexts }].slice(
					-MAX_PENDING_PROMPTS,
				);
				return undefined;
			});

		if (events.has("UserPromptSubmit") || events.has("SessionStart"))
			pi.on("before_agent_start", async (event, ctx) => {
				if (ctx.agent.kind !== "main" || !enabled()) return undefined;
				const contexts = pendingSessionContexts;
				pendingSessionContexts = [];
				const matched = pendingPrompts.filter(pending => event.prompt.includes(pending.text));
				if (matched.length > 0) {
					pendingPrompts = pendingPrompts.filter(pending => !matched.includes(pending));
					for (const pending of matched) contexts.push(...pending.contexts);
				} else if (events.has("UserPromptSubmit") && event.prompt.trim() !== "") {
					// Prompts that bypassed `input` (print mode, extension-sent prompts) can add context
					// but no longer be withdrawn.
					const result = await userPromptSubmit(ctx, event.prompt);
					if (result.blocked !== undefined) {
						ctx.ui.notify(
							forDisplay(
								`UserPromptSubmit hook asked to block a prompt omp had already accepted:\n${result.blocked}`,
							),
							"warning",
						);
					}
					contexts.push(...result.contexts);
				}
				if (contexts.length === 0) return undefined;
				return {
					message: {
						customType: HOOK_CONTEXT_MESSAGE_TYPE,
						content: contexts.join("\n\n"),
						display: false,
						attribution: "agent",
					},
				};
			});

		if (events.has("PreToolUse"))
			pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
				const input = event.input as Record<string, unknown>;
				const toolName = claudeToolName(event.toolName, input);
				const outcomes = await runHooks(
					ctx,
					"PreToolUse",
					toolName,
					{
						tool_name: toolName,
						tool_input: toClaudeToolInput(event.toolName, input),
						tool_use_id: event.toolCallId,
					},
					toolCallBudgetMs(),
				);
				if (outcomes.length === 0) return undefined;
				const label = `PreToolUse:${toolName}`;
				const stop = stopRequest(outcomes, label);
				if (stop !== undefined) {
					ctx.ui.notify(forDisplay(stop), "warning");
					ctx.abort();
					return { block: true, reason: hookMessage(label, "stopped the session", stop) };
				}
				const denials: string[] = [];
				const asks: string[] = [];
				let asked = false;
				let updatedInput: Record<string, unknown> | undefined;
				for (const outcome of outcomes) {
					if (outcome.status === "block") {
						denials.push(outcome.text || `blocked by ${commandLabel(outcome.hook)}`);
						continue;
					}
					if (outcome.status !== "success" || !outcome.json) continue;
					const specific = hookSpecificOutput(outcome);
					const legacy = outcome.json.decision;
					const decision =
						specific?.permissionDecision ??
						(legacy === "approve" ? "allow" : legacy === "block" ? "deny" : undefined);
					const reason = stringField(specific, "permissionDecisionReason") ?? stringField(outcome.json, "reason");
					if (decision === "deny") {
						denials.push(reason ?? `denied by ${commandLabel(outcome.hook)}`);
					} else if (decision === "ask") {
						asked = true;
						if (reason) asks.push(reason);
					}
					if (isRecord(specific?.updatedInput)) updatedInput = specific.updatedInput;
				}
				if (denials.length > 0) {
					return { block: true, reason: hookMessage(label, "blocked this tool call", denials.join("\n")) };
				}
				const effectiveInput = updatedInput ? fromClaudeToolInput(event.toolName, input, updatedInput) : undefined;
				if (asked) {
					const reason = `${label} hook${asks.length > 0 ? `: ${asks.join("; ")}` : " asks for confirmation"}`;
					if (!ctx.hasUI) {
						return {
							block: true,
							reason: hookMessage(label, "requires approval, but no interactive UI is available", reason),
						};
					}
					const answer = await requestApproval(
						ctx.ui,
						{ name: event.toolName, formatApprovalDetails: args => formatApprovalArguments(args) },
						effectiveInput ?? input,
						{ reason },
					);
					if (answer === "deny") {
						return { block: true, reason: hookMessage(label, "approval was denied by the user", reason) };
					}
				}
				const contexts = additionalContexts(outcomes, false);
				const result: ToolCallEventResult = {};
				if (effectiveInput) result.input = effectiveInput;
				if (contexts.length > 0)
					result.additionalContext = hookMessage(label, "additional context", contexts.join("\n\n"));
				return result.input || result.additionalContext ? result : undefined;
			});

		if (events.has("PostToolUse"))
			pi.on("tool_result", async (event, ctx) => {
				// Claude Code runs PostToolUse for successful calls only.
				if (event.isError) return undefined;
				const toolName = claudeToolName(event.toolName, event.input);
				const outcomes = await runHooks(ctx, "PostToolUse", toolName, {
					tool_name: toolName,
					tool_input: toClaudeToolInput(event.toolName, event.input),
					tool_response: toClaudeToolResponse(event),
					tool_use_id: event.toolCallId,
				});
				if (outcomes.length === 0) return undefined;
				const label = `PostToolUse:${toolName}`;
				const stop = stopRequest(outcomes, label);
				if (stop !== undefined) {
					ctx.ui.notify(forDisplay(stop), "warning");
					ctx.abort();
				}
				const messages: string[] = [];
				const feedback = blockReasons(outcomes, label);
				if (feedback.length > 0) {
					ctx.ui.notify(forDisplay(`${label} hook feedback:\n${feedback.join("\n")}`), "warning");
					messages.push(hookMessage(label, "feedback", feedback.join("\n")));
				}
				const contexts = additionalContexts(outcomes, false);
				if (contexts.length > 0) messages.push(hookMessage(label, "additional context", contexts.join("\n\n")));
				return messages.length > 0 ? { additionalContext: messages.join("\n\n") } : undefined;
			});

		if (events.has("Stop"))
			pi.on("session_stop", async (event, ctx) => {
				const outcomes = await runHooks(ctx, "Stop", undefined, {
					stop_hook_active: event.stop_hook_active,
					last_assistant_message: messageText(event.last_assistant_message),
				});
				if (outcomes.length === 0 || stopRequest(outcomes, "Stop") !== undefined) return undefined;
				const reasons = blockReasons(outcomes, "Stop");
				if (reasons.length > 0) {
					ctx.ui.notify(forDisplay(`Stop hook feedback:\n${reasons.join("\n")}`), "warning");
					return { decision: "block", reason: hookMessage("Stop", "feedback", reasons.join("\n")) };
				}
				const contexts = additionalContexts(outcomes, false);
				if (contexts.length === 0) return undefined;
				return { continue: true, additionalContext: hookMessage("Stop", "feedback", contexts.join("\n\n")) };
			});

		if (events.has("SubagentStop"))
			pi.on("agent_end", async (event, ctx) => {
				if (ctx.agent.kind !== "sub" || event.willContinue) return;
				const lastAssistant = [...event.messages].reverse().find(message => message.role === "assistant");
				const outcomes = await runHooks(ctx, "SubagentStop", undefined, {
					stop_hook_active: false,
					last_assistant_message: messageText(lastAssistant),
				});
				const reasons = blockReasons(outcomes, "SubagentStop");
				if (reasons.length > 0) {
					ctx.ui.notify(
						forDisplay(`SubagentStop hook cannot keep a subagent running in omp:\n${reasons.join("\n")}`),
						"warning",
					);
				}
			});

		if (events.has("Notification"))
			pi.on("tool_approval_requested", (event, ctx) => {
				if (!enabled()) return;
				const toolName = CLAUDE_TOOL_NAMES[event.toolName] ?? event.toolName;
				// Notification hooks are informational: never hold up the approval prompt.
				void runHooks(ctx, "Notification", "permission_prompt", {
					message: `Claude needs your permission to use ${toolName}`,
					title: "Permission needed",
					notification_type: "permission_prompt",
				}).catch(error => logger.warn("Claude Code Notification hook failed", { error: String(error) }));
			});
	};
}
