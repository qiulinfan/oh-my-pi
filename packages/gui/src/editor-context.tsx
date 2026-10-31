/**
 * Where the user is in the editor embedding this page: the Obsidian or VS Code
 * side bar posts the file, caret, selection and nearby lines it last had
 * (`{ type: EDITOR_CONTEXT, context }`), from the frame's parent in VS Code,
 * and into the page itself from Obsidian's <webview>. Every open session is
 * told (a TSP `context` event), and omp hands it to the model with the user's
 * next prompt. The composer shows it with a button that withdraws it; the
 * withdrawal holds until the editor reports another place.
 *
 * A page no editor embeds never hears of a place, so it never tells a session
 * anything and cannot clear the place another view of that session reported.
 */
import { parseTspEditorContext, type TspEditorContext } from "@oh-my-pi/pi-wire";
import { type ReactNode, useSyncExternalStore } from "react";
import { Icon } from "./icons";

export const EDITOR_CONTEXT = "omp-gui.editor-context";

let reported: TspEditorContext | null = null;
let withdrawn = false;
const listeners = new Set<() => void>();

/** The place to tell omp: null when the editor reported none or the user withdrew it; undefined when no editor ever reported. */
export function editorContext(): TspEditorContext | null | undefined {
	if (!reported) return undefined;
	return withdrawn ? null : reported;
}

export function subscribeEditorContext(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function changed(): void {
	for (const listener of listeners) listener();
}

export function listenToEmbedder(): void {
	window.addEventListener("message", event => {
		// The embedder: a frame's parent, or for a top-level page (Obsidian's <webview>) the page itself.
		if (event.source !== window.parent) return;
		const data = event.data as { type?: unknown; context?: unknown } | null;
		if (data?.type !== EDITOR_CONTEXT) return;
		const next = parseTspEditorContext(data.context);
		if (!next || JSON.stringify(next) === JSON.stringify(reported)) return;
		reported = next;
		withdrawn = false;
		changed();
	});
}

/** The reported place above the prompt, with the button that withdraws it. */
export function EditorContextChip(): ReactNode {
	const context = useSyncExternalStore(subscribeEditorContext, editorContext);
	if (!context) return null;
	const name = context.path.split(/[\\/]/).pop() ?? context.path;
	const selected = context.selection ? ` · ${context.selection.length} chars selected` : "";
	return (
		<div className="editor-context">
			<span className="editor-context-where" title={`${context.path}:${context.line}:${context.col}`}>
				<Icon name="file-text" size={12} />
				<span className="editor-context-name">{name}</span>
				<span className="editor-context-pos">
					:{context.line}:{context.col}
					{selected}
				</span>
			</span>
			<button
				type="button"
				className="editor-context-drop"
				title="Don't send this place with the next message"
				onClick={() => {
					withdrawn = true;
					changed();
				}}
			>
				<Icon name="x" size={12} />
			</button>
		</div>
	);
}
