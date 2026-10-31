/**
 * Where the user is in an editor that shows the GUI page beside its files (the
 * Obsidian and VS Code plugins in this repository), in the shape the page
 * takes (packages/gui/src/editor-context.tsx, TSP `context` in pi-wire): the
 * file, the caret, the selection and the lines around the caret. The page
 * tells omp, which hands it to the model with the user's next prompt.
 */

/** The message type the page listens for: `{ type: EDITOR_CONTEXT, context }`. */
export const EDITOR_CONTEXT = "omp-gui.editor-context";

export interface EditorContext {
	path: string;
	line: number;
	col: number;
	selection?: string;
	excerpt: { start: number; text: string };
}

/** Lines shown on each side of the caret's line. */
const AROUND = 8;
/** Longest line kept whole; a longer one (a minified file, a long paragraph) is cut. */
const LINE_CHARS = 400;
/** Longest selection kept whole. */
const SELECTION_CHARS = 8000;

function cut(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The context for a caret at 0-based `line` and `ch` of the file at absolute
 * `path`, which has `lineCount` lines read through `lineAt`.
 */
export function editorContext(
	path: string,
	caret: { line: number; ch: number },
	selection: string,
	lineCount: number,
	lineAt: (line: number) => string,
): EditorContext {
	const first = Math.max(0, caret.line - AROUND);
	const last = Math.min(lineCount - 1, caret.line + AROUND);
	const lines: string[] = [];
	for (let n = first; n <= last; n++) lines.push(cut(lineAt(n), LINE_CHARS));
	return {
		path,
		line: caret.line + 1,
		col: caret.ch + 1,
		...(selection ? { selection: cut(selection, SELECTION_CHARS) } : {}),
		excerpt: { start: first + 1, text: lines.join("\n") },
	};
}
