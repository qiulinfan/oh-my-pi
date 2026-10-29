/**
 * Process-wide work-detail mode: how much of its work a session shows on a
 * TSP surface (omp gui, Tern). The plain-terminal row renderer never reads it.
 *
 * - `compact`: thinking and tool rows start folded to one line, also while
 *   they stream; a folded live thought previews its latest paragraph.
 * - `standard`: thinking is open while it streams and folds when it ends;
 *   tool rows fold to their preview.
 * - `verbose`: thinking and tool output start open.
 *
 * A row the user toggled keeps that choice until the mode changes again:
 * every change bumps {@link workDetailEpoch}, and components record the epoch
 * of a toggle and drop it once the epoch moves on. The epoch also belongs in
 * every describe memo key that depends on the mode.
 */

export const WORK_DETAILS = ["compact", "standard", "verbose"] as const;
export type WorkDetail = (typeof WORK_DETAILS)[number];

/** How each mode is named and described to people (composer chip, picker, settings). */
export const WORK_DETAIL_INFO: Readonly<Record<WorkDetail, { readonly label: string; readonly detail: string }>> = {
	compact: { label: "Compact", detail: "Thinking and tool calls fold to one line, also while they stream" },
	standard: { label: "Standard", detail: "Thinking stays open while it streams; tool calls show a short preview" },
	verbose: { label: "Verbose", detail: "Thinking and tool output stay open" },
};

let mode: WorkDetail = "standard";
let epoch = 0;

export function isWorkDetail(value: unknown): value is WorkDetail {
	return (WORK_DETAILS as readonly unknown[]).includes(value);
}

/** The current mode. */
export function getWorkDetail(): WorkDetail {
	return mode;
}

/** Bumped by every mode change; see the module doc. */
export function workDetailEpoch(): number {
	return epoch;
}

/** Set the mode; returns whether it changed (the caller then renders). */
export function setWorkDetail(next: WorkDetail): boolean {
	if (next === mode) return false;
	mode = next;
	epoch++;
	return true;
}

/** A per-row toggle stamped with the epoch it was made in. */
export interface WorkDetailToggle {
	readonly expanded: boolean;
	readonly epoch: number;
}

/** `toggle`'s choice while the mode is still the one it was made under, else undefined. */
export function currentToggle(toggle: WorkDetailToggle | undefined): boolean | undefined {
	return toggle !== undefined && toggle.epoch === epoch ? toggle.expanded : undefined;
}

/**
 * Whether a row's content shows expanded on a TSP surface: the user's toggle while it is current,
 * else verbose or the host's expansion (`Ctrl+O`, the transcript-wide state).
 */
export function rowExpanded(toggle: WorkDetailToggle | undefined, hostExpanded: boolean): boolean {
	return currentToggle(toggle) ?? (mode === "verbose" || hostExpanded);
}
