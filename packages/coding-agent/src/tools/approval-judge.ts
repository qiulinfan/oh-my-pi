/**
 * The approval judge behind `tools.approvalMode: auto`.
 *
 * Static rules decide first (tool and user policies, `bash.patterns`, critical commands); an
 * exec-tier call that `auto` would otherwise prompt for is put to the `judge` role chain as one
 * choice question: run it (`allow`), ask the user (`prompt`), or refuse it (`deny`). A verdict is
 * remembered for the session, keyed by the tool and its exact arguments. Any failure — no judge,
 * no credential, a timeout, an unusable answer — yields no verdict, and the caller prompts (or
 * refuses where no user can answer).
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { judgeQuestions, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { journalJudgmentUsage, type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/approval.json" with { type: "json" };
import { operatorTitleText } from "../session/messages";
import type { SessionManager } from "../session/session-manager";
import { formatApprovalArguments, formatApprovalPrompt } from "./approval";

const QUESTIONS = judgeQuestions(questionFile);

/**
 * Probability an `allow` or `deny` answer needs to stand. Keyword judges answer exactly 0 or 1; a
 * calibrated judge torn between answers falls back to asking the user.
 */
const VERDICT_THRESHOLD = 0.6;

/** How long one call waits for the judge before asking the user instead. */
const APPROVAL_JUDGE_TIMEOUT_MS = 20_000;

/** Leading characters of the user's latest request shown to the judge. */
const REQUEST_CHARS = 2000;

/** Remembered verdicts are dropped oldest first beyond this many per runner. */
const MAX_REMEMBERED_VERDICTS = 512;

export type ApprovalJudgeVerdict = "allow" | "prompt" | "deny";

/** The call put to the judge. */
export interface ApprovalJudgeCall {
	tool: string;
	/** The approval prompt body for the call: the tool's own detail rows, or its arguments. */
	call: string;
	cwd: string;
	/** The user's latest request, when the session has one. */
	request?: string;
}

export interface ApprovalJudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** Active session model; last resort of the judge role chain. */
	model?: Model;
	sessionId?: string;
	onUsage?: (usage: JudgmentUsage) => void;
	signal?: AbortSignal;
}

/**
 * Ask the judge whether `call` may run without the user.
 * @throws when no judge can answer.
 */
export async function judgeToolApproval(
	call: ApprovalJudgeCall,
	deps: ApprovalJudgeDeps,
): Promise<ApprovalJudgeVerdict> {
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionModel: deps.model,
		sessionId: deps.sessionId,
		purpose: "approval",
		onUsage: deps.onUsage,
		cache: sharedJudgmentCache(),
	});
	const state = {
		tool: call.tool,
		cwd: call.cwd,
		call: call.call,
		...(call.request ? { request: call.request } : {}),
	};
	const { answers } = await judge.judge({ state, questions: { verdict: QUESTIONS.verdict } }, { signal: deps.signal });
	const { choice, probabilities } = answers.verdict;
	if (choice === "prompt") return "prompt";
	return (probabilities[choice] ?? 0) >= VERDICT_THRESHOLD ? choice : "prompt";
}

/** The latest message the user wrote on the session's current branch. */
function latestUserRequest(sessionManager: Pick<SessionManager, "getBranch">): string | undefined {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message") continue;
		const request = operatorTitleText(entry.message)?.trim();
		if (request) return request.slice(0, REQUEST_CHARS);
	}
	return undefined;
}

export interface JudgeApprovalOptions {
	tool: Pick<AgentTool, "name" | "formatApprovalDetails">;
	args: unknown;
	settings: Settings;
	registry: ModelRegistry;
	model?: Model;
	sessionManager: Pick<SessionManager, "getBranch" | "getCwd" | "getSessionId"> & Partial<SessionManager>;
	/** The session's remembered verdicts, keyed by session, tool, and arguments. */
	verdicts: Map<string, ApprovalJudgeVerdict>;
	signal?: AbortSignal;
}

/**
 * `auto` mode's verdict for one call: a remembered one, else the judge's. `undefined` when no judge
 * could answer in time; the caller then asks the user.
 */
export async function judgeApproval(options: JudgeApprovalOptions): Promise<ApprovalJudgeVerdict | undefined> {
	const { tool, args, sessionManager, verdicts } = options;
	const sessionId = sessionManager.getSessionId();
	let key: string;
	try {
		key = `${sessionId}\0${tool.name}\0${JSON.stringify(args) ?? ""}`;
	} catch {
		return undefined;
	}
	const remembered = verdicts.get(key);
	if (remembered) return remembered;

	const details = formatApprovalPrompt(tool, args);
	const call = tool.formatApprovalDetails ? details : [details, ...formatApprovalArguments(args)].join("\n");
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(APPROVAL_JUDGE_TIMEOUT_MS)])
		: AbortSignal.timeout(APPROVAL_JUDGE_TIMEOUT_MS);
	let verdict: ApprovalJudgeVerdict;
	try {
		verdict = await judgeToolApproval(
			{ tool: tool.name, call, cwd: sessionManager.getCwd(), request: latestUserRequest(sessionManager) },
			{
				settings: options.settings,
				registry: options.registry,
				model: options.model,
				sessionId,
				onUsage: journalJudgmentUsage(sessionManager),
				signal,
			},
		);
	} catch (error) {
		logger.debug("approval judge: no verdict, asking the user", {
			tool: tool.name,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (verdicts.size >= MAX_REMEMBERED_VERDICTS) {
		const oldest = verdicts.keys().next().value;
		if (oldest !== undefined) verdicts.delete(oldest);
	}
	verdicts.set(key, verdict);
	return verdict;
}
