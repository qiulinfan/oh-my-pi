/**
 * The conversation/code choice a rewind to a user message offers when file
 * checkpoints show files changed since that message. Shared by the transcript
 * rewind selector (Esc-Esc, `/rewind`, `/branch`) and `/tree`.
 */
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import type { FileRestorePlan } from "../../session/file-checkpoints";
import { formatPathRelativeToCwd } from "../../tools/path-utils";
import type { InteractiveModeContext } from "../types";

export type RewindScope = "conversation" | "code" | "both";

export interface RewindScopeChoice {
	scope: RewindScope;
	/** Present when the choice restores code. */
	plan?: FileRestorePlan;
}

const CONVERSATION_ONLY = "Restore conversation only";
const CODE_ONLY = "Restore code only";
const BOTH = "Restore conversation and code";
const MAX_LISTED_FILES = 15;

const ACTION_MARKERS: Record<FileRestorePlan["changes"][number]["action"], string> = {
	modify: "M",
	recreate: "A",
	delete: "D",
};

/** File list shown before a code restore: one `M`/`A`/`D` line per file, relative to `cwd`. */
export function formatRestorePlan(plan: FileRestorePlan, cwd: string): string[] {
	const lines = plan.changes
		.slice(0, MAX_LISTED_FILES)
		.map(change => `  ${ACTION_MARKERS[change.action]} ${replaceTabs(formatPathRelativeToCwd(change.path, cwd))}`);
	const hidden = plan.changes.length - MAX_LISTED_FILES;
	if (hidden > 0) lines.push(`  … and ${hidden} more`);
	return lines;
}

/**
 * Ask how far a rewind to `entryId` reaches. Returns `{ scope: "conversation" }`
 * without asking when nothing is restorable (no checkpoints, not a user
 * message, no file differs), and undefined when the user cancels.
 * `beforePrompt` runs only when the dialog is shown (e.g. to close a fullscreen overlay).
 */
export async function chooseRewindScope(
	ctx: InteractiveModeContext,
	entryId: string,
	isUserTarget: boolean,
	beforePrompt: () => void,
): Promise<RewindScopeChoice | undefined> {
	const store = ctx.session.fileCheckpoints;
	if (!store || !isUserTarget) return { scope: "conversation" };
	const plan = await store.planRestore(entryId);
	if (plan.changes.length === 0) return { scope: "conversation" };
	if (!plan.complete) {
		ctx.showWarning("File checkpoints for this point were removed by retention; restoring the conversation only.");
		return { scope: "conversation" };
	}

	beforePrompt();
	const count = plan.changes.length;
	const title = [
		`${count} file${count === 1 ? "" : "s"} changed by omp's file tools since this message (M modify, A re-create, D delete):`,
		...formatRestorePlan(plan, ctx.sessionManager.getCwd()),
		"Changes made by bash/eval commands or outside omp are not restored.",
	].join("\n");
	const answer = await ctx.showHookSelector(title, [CONVERSATION_ONLY, CODE_ONLY, BOTH]);
	if (answer === undefined) return undefined;
	if (answer === CODE_ONLY) return { scope: "code", plan };
	if (answer === BOTH) return { scope: "both", plan };
	return { scope: "conversation" };
}

/** Write a plan back to disk and report the outcome in the status line. */
export async function restoreCodeFromPlan(ctx: InteractiveModeContext, plan: FileRestorePlan): Promise<void> {
	const store = ctx.session.fileCheckpoints;
	if (!store) return;
	try {
		const result = await store.applyRestore(plan);
		if (result.failed.length > 0) {
			const cwd = ctx.sessionManager.getCwd();
			const failures = result.failed.map(
				failure => `${replaceTabs(formatPathRelativeToCwd(failure.path, cwd))}: ${failure.error}`,
			);
			ctx.showError(
				`Restored ${result.restored.length} of ${plan.changes.length} files; failed:\n${failures.join("\n")}`,
			);
			return;
		}
		ctx.showStatus(`Restored ${result.restored.length} file${result.restored.length === 1 ? "" : "s"}`);
	} catch (error) {
		ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
