/**
 * The front end that started this process's sessions, recorded in each new
 * session's header so a saved session says whether it came from the TUI, the
 * GUI, an editor over ACP, or automation. Only the CLI entry sets it; sessions
 * an SDK embedder creates carry none.
 */
import type { PeerMode } from "../peers/registry";

export interface SessionOrigin {
	mode: PeerMode;
	/** The ACP client's `clientInfo.name` (`zed`, `iina`), or `omp-gui` for a TUI the GUI server hosts. */
	client?: string;
}

let origin: SessionOrigin | undefined;

export function setSessionOrigin(value: SessionOrigin | undefined): void {
	origin = value;
}

/** Name the ACP client once it has introduced itself. */
export function setSessionOriginClient(client: string | undefined): void {
	if (origin && client) origin = { ...origin, client };
}

export function getSessionOrigin(): SessionOrigin | undefined {
	return origin;
}
