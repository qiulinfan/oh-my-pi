import * as path from "node:path";
import type { TspEditorContext } from "@oh-my-pi/pi-wire";
import { formatCount } from "@oh-my-pi/pi-utils";
import type { TranscriptBlock } from "../chrome/transcript-container";
import { TranscriptStatusBlock } from "../chrome/transcript-status";
import { span } from "../native/describe";
import { shortenPath } from "../render/render-utils";
import { theme } from "../theme";
import type { CustomMessage } from "./messages";

/**
 * One line for an `editor-context` notice: the file and caret the user's
 * editor reported with their prompt, the file relative to `cwd` when inside
 * it. The excerpt it carries is for the model.
 */
export function createEditorContextBlock(message: CustomMessage<unknown>, cwd: string): TranscriptBlock {
	const context = (message as CustomMessage<Partial<TspEditorContext>>).details;
	const file = context?.path ?? "unknown";
	const relative = path.relative(cwd, file);
	const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : shortenPath(file);
	const where = `${shown}:${context?.line ?? "?"}:${context?.col ?? "?"}`;
	const selected = context?.selection ? `${formatCount("character", context.selection.length)} selected` : undefined;
	const spans = [span("Editor"), span(" "), span(where, "path")];
	if (selected) spans.push(span(" · ", "dim"), span(selected, "dim"));
	return new TranscriptStatusBlock([
		{
			parts: [
				{ text: theme.tree.last, color: "dim" },
				{ text: "Editor", color: "muted" },
				{ text: where, color: "accent" },
				selected ? { text: `(${selected})`, color: "dim" } : undefined,
			],
			native: { tone: "info", icon: "read", message: spans },
		},
	]);
}
