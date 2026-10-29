/**
 * What the composer knows about omp's copy of its text. The textarea sends
 * each change as a TSP `edit` (the minimal replaced range against the text the
 * previous edit produced), and omp echoes every edit it applies. An echo of a
 * state the textarea already moved past only acknowledges that edit; any other
 * text is omp's own change (sent, cleared, history, completion), which the
 * textarea takes.
 *
 * Edits sent into a socket that was dying may never have reached omp, and
 * echoes of edits that did may never have come back. A reconnect's snapshot
 * shows what omp holds: `rebase` makes it the base of the next edit, so omp
 * gets exactly what it missed, once, unless omp changed its text on its own in
 * the gap, which then wins.
 *
 * A key sent while edits were still unechoed leaves omp's text unknown: the
 * key may have changed it to what omp last showed (Enter sends the text and
 * clears it). Until omp shows its text again, a snapshot is omp's own change
 * unless it is an edit sent since, so a sent message is never typed again; if
 * the key and those edits were all lost, the typed text is lost with them.
 */

/** A TSP `edit` range: replace `[from, to)` of a text of length `len` with `text`. */
export interface TextEdit {
	from: number;
	to: number;
	text: string;
	len: number;
}

/** The minimal edit that turns `before` into `after`, or null when they are equal. */
export function textEdit(before: string, after: string): TextEdit | null {
	if (before === after) return null;
	let from = 0;
	while (from < before.length && from < after.length && before[from] === after[from]) from++;
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	return { from, to: endBefore, text: after.slice(from, endAfter), len: before.length };
}

export class ComposerSync {
	/** The text omp will hold once it has applied every edit sent so far; edits are computed against it. */
	#known: string;
	/** The text omp last showed: its latest echo, or a snapshot's; null while a key may have changed it unseen. */
	#heard: string | null;
	/** Texts of the edits omp has not echoed yet, oldest first. */
	#pending: string[] = [];

	constructor(text: string) {
		this.#known = text;
		this.#heard = text;
	}

	/** No edit is in flight and the textarea holds `value`, which omp holds too: a caret omp moves applies. */
	settled(value: string): boolean {
		return this.#pending.length === 0 && value === this.#known;
	}

	/**
	 * omp's text is now `text`. False when that only acknowledges edits sent from here (the textarea is at or
	 * past it); true when it is omp's own change, which the textarea takes.
	 */
	heard(text: string): boolean {
		this.#heard = text;
		const acked = this.#pending.indexOf(text);
		if (acked >= 0) {
			this.#pending.splice(0, acked + 1);
			return false;
		}
		this.#pending = [];
		this.#known = text;
		return true;
	}

	/** The textarea holds `value`: the edit that brings omp there, counted as sent; null when there is none. */
	edit(value: string): TextEdit | null {
		const edit = textEdit(this.#known, value);
		if (!edit) return null;
		this.#known = value;
		this.#pending.push(value);
		return edit;
	}

	/**
	 * A key omp binds itself goes to omp. It may change the text (submit clears it, Tab completes, Up recalls
	 * history), and omp can fold the echoes of the edits before it into that one change: its next text wins.
	 * With edits in flight, what omp held when the key arrived is unknown, so the text it last showed no longer
	 * tells a key that did nothing from one that changed the text back to it.
	 */
	keyed(): void {
		if (this.#pending.length > 0) this.#heard = null;
		this.#pending = [];
	}

	/**
	 * A fresh snapshot (a reconnect's `init`) shows omp holding `text`, which becomes the base of the next
	 * edit. True when omp changed its text on its own in the gap, which the textarea then takes; false when
	 * `text` is what omp last showed (and no key may have changed it since) or an edit sent from here, and the
	 * next `edit` sends what omp missed.
	 */
	rebase(text: string): boolean {
		const own = text !== this.#heard && !this.#pending.includes(text);
		this.#pending = [];
		this.#known = text;
		this.#heard = text;
		return own;
	}
}
