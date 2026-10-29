/**
 * How the GUI server reads what omp writes to its terminal. Escape strings
 * (APC, DCS, OSC) carry the Tern Surface Protocol and the few reports the
 * server handles; CSI sequences are the ANSI queries omp sends at startup, or
 * formatting; plain text between them is what omp prints outside the protocol,
 * such as the error it dies with. The splitter holds no session state, so its
 * recovery rules can be tested on their own.
 */
import { sanitizeDisplayLines } from "@oh-my-pi/pi-tui/render";

const ESC = "\x1b";
const BEL = "\x07";
const CSI = /^\x1b\[([?>=<]?)([0-9;:$]*)([ -/]*)([@-~])/;

/** The introducer of an escape string: APC (`_`), DCS (`P`) or OSC (`]`). */
export type StringKind = "_" | "P" | "]";

/**
 * Why an escape string was dropped unread: another escape began before its terminator (no escape can be
 * inside one, so it was cut off), it grew past any message omp writes without ending, or the stream ended
 * inside it (omp let go of its terminal while writing it).
 */
export type DropReason = "cut-off" | "overflow" | "unterminated";

export interface PtyStreamSink {
	/** A whole escape string: its body, without the introducer and the terminator. */
	string(kind: StringKind, body: string): void;
	/** A whole CSI sequence. */
	csi(prefix: string, params: string, final: string): void;
	/** Plain text outside every escape sequence. */
	text(text: string): void;
	/** An escape string dropped unread, `length` characters of it. */
	dropped(kind: StringKind, reason: DropReason, length: number): void;
}

/**
 * Far longer than any message omp writes (it chunks TSP messages at 64 KiB): an escape string still
 * unterminated past this is dropped, with the rest of it as it arrives.
 */
export const MAX_PENDING_CHARS = 8 * 1024 * 1024;

/** The longest CSI sequence waited for; an unfinished one longer than this never was one. */
const MAX_CSI_CHARS = 64;

export class PtyStream {
	readonly #sink: PtyStreamSink;
	readonly #maxPending: number;
	readonly #decoder = new TextDecoder();
	#buf = "";
	/** How far the pending escape string at the head of `#buf` was searched for its terminator. */
	#scanned = 0;
	/** The rest of an overflowed escape string is arriving: it is dropped up to the next escape. */
	#skipping = false;

	constructor(sink: PtyStreamSink, maxPending = MAX_PENDING_CHARS) {
		this.#sink = sink;
		this.#maxPending = maxPending;
	}

	write(bytes: Uint8Array): void {
		this.#buf += this.#decoder.decode(bytes, { stream: true });
		this.#drain();
	}

	/** Forget any partial sequence (after a fault, when its state is unknown); the next escape starts afresh. */
	reset(): void {
		this.#buf = "";
		this.#scanned = 0;
		this.#skipping = false;
	}

	/**
	 * The stream has ended (omp let go of its terminal): drop a sequence it never finished, and pass on what it
	 * printed after the line it broke off. No escape string omp writes holds a raw line break (TSP bodies are
	 * JSON or base64), so text past one was written after omp stopped writing the string: the error it died
	 * with, say, printed without an escape that would have cut the string off.
	 */
	end(): void {
		this.#buf += this.#decoder.decode();
		this.#drain();
		const rest = this.#buf;
		this.reset();
		const kind = rest[1];
		if (kind !== "_" && kind !== "P" && kind !== "]") return; // nothing, a lone ESC or a CSI cut short: no text
		this.#sink.dropped(kind, "unterminated", rest.length);
		const line = rest.search(/[\r\n]/);
		if (line !== -1) this.#sink.text(rest.slice(line));
	}

	#drain(): void {
		for (;;) {
			const esc = this.#buf.indexOf(ESC);
			if (esc === -1) {
				this.#text(this.#buf);
				this.#buf = "";
				return;
			}
			if (esc > 0) {
				this.#text(this.#buf.slice(0, esc));
				this.#consume(esc);
			}
			this.#skipping = false;
			if (this.#buf.length < 2) return;
			const kind = this.#buf[1];
			let taken = true;
			if (kind === "_" || kind === "P" || kind === "]") taken = this.#string(kind);
			else if (kind === "[") taken = this.#csi();
			// Two-byte escapes (ESC 7, ESC =, a stray ESC \): skipped.
			else this.#consume(2);
			if (!taken) return;
		}
	}

	/** Take the escape string at the head; false while it waits for more of itself. */
	#string(kind: StringKind): boolean {
		const buf = this.#buf;
		const from = Math.max(2, this.#scanned);
		let next = buf.indexOf(ESC, from);
		// tmux's passthrough (`ESC P tmux; … ESC \`) doubles each ESC of the sequence it carries: in a DCS such a
		// pair is part of the string, not an escape that cuts it off.
		while (kind === "P" && next !== -1 && buf[next + 1] === ESC) next = buf.indexOf(ESC, next + 2);
		const bel = kind === "]" ? buf.indexOf(BEL, from) : -1;
		if (bel !== -1 && (next === -1 || bel < next)) {
			// OSC may also end with BEL.
			const body = buf.slice(2, bel);
			this.#consume(bel + 1);
			this.#sink.string(kind, body);
			return true;
		}
		if (next === -1 || next === buf.length - 1) {
			// Not terminated yet, or the last character may begin its terminator.
			if (buf.length <= this.#maxPending) {
				this.#scanned = next === -1 ? buf.length : next;
				return false;
			}
			this.#sink.dropped(kind, "overflow", buf.length);
			if (next === -1) {
				this.reset();
				this.#skipping = true;
				return false;
			}
			this.#consume(next);
			return true;
		}
		if (buf[next + 1] === "\\") {
			const body = buf.slice(2, next);
			this.#consume(next + 2);
			this.#sink.string(kind, body);
			return true;
		}
		// Another escape before the terminator: this string was cut off, and parsing goes on from that escape.
		this.#consume(next);
		this.#sink.dropped(kind, "cut-off", next);
		return true;
	}

	/** Take the CSI sequence at the head; false while it waits for more of itself. */
	#csi(): boolean {
		const match = CSI.exec(this.#buf);
		if (match) {
			this.#consume(match[0].length);
			this.#sink.csi(match[1]!, match[2]!, match[3]! + match[4]!);
			return true;
		}
		// An escape inside it cut it off; one this long never was one, and what follows the ESC is text.
		const next = this.#buf.indexOf(ESC, 2);
		if (next !== -1) this.#consume(next);
		else if (this.#buf.length > MAX_CSI_CHARS) this.#consume(1);
		else return false;
		return true;
	}

	#consume(count: number): void {
		this.#buf = this.#buf.slice(count);
		this.#scanned = 0;
	}

	#text(text: string): void {
		if (text && !this.#skipping) this.#sink.text(text);
	}
}

/** How much of omp's output outside the protocol an ended session shows: its last lines, within a size. */
export const OUTPUT_TAIL_LINES = 40;
export const OUTPUT_TAIL_CHARS = 8 * 1024;

/** A rolling tail of omp's plain output, kept raw and sanitized for display when it is read. */
export class OutputTail {
	#raw = "";

	push(text: string): void {
		this.#raw += text;
		// Kept raw at up to four times the shown size: overwritten progress lines and controls shrink when sanitized.
		if (this.#raw.length > 4 * OUTPUT_TAIL_CHARS) this.#raw = this.#raw.slice(-2 * OUTPUT_TAIL_CHARS);
	}

	/** The last lines, sanitized (controls stripped, tabs expanded, `\r` overwrites resolved); undefined when blank. */
	text(): string | undefined {
		// A `\r` that ends a line, or the output, overwrites nothing. The terminal turns each "\n" into "\r\n", so a
		// "\r\n" omp writes arrives as "\r\r\n".
		const raw = this.#raw.replace(/\r+\n/g, "\n").replace(/\r+$/, "");
		const lines = sanitizeDisplayLines(raw).map(line => line.trimEnd());
		while (lines.length > 0 && lines.at(-1) === "") lines.pop();
		let text = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
		if (text.length > OUTPUT_TAIL_CHARS) {
			text = text.slice(-OUTPUT_TAIL_CHARS).toWellFormed();
			// Start at a whole line when one begins within the budget.
			const newline = text.indexOf("\n");
			if (newline !== -1 && newline < text.length - 1) text = text.slice(newline + 1);
		}
		text = text.replace(/^\n+/, "");
		return text.trim() ? text : undefined;
	}
}
