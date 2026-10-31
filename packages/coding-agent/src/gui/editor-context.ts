/**
 * A session `omp gui` starts with a first message gets the place the user is
 * in the editor embedding the page (the Obsidian or VS Code side bar) through
 * this variable: the page's `context` event cannot reach omp before omp sends
 * that message. Later places arrive as TSP `context` events.
 */
import { parseTspEditorContext, type TspEditorContext } from "@oh-my-pi/pi-wire";

export const EDITOR_CONTEXT_ENV = "OMP_GUI_EDITOR_CONTEXT";

/** The place `omp gui` handed this process, taken out of the environment so commands the agent runs never see it. */
export function takeEditorContext(): TspEditorContext | null {
	const raw = process.env[EDITOR_CONTEXT_ENV];
	delete process.env[EDITOR_CONTEXT_ENV];
	if (!raw) return null;
	try {
		return parseTspEditorContext(JSON.parse(raw));
	} catch {
		return null;
	}
}
