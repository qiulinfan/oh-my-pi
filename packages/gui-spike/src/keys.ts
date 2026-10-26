/**
 * Browser key events → the bytes a legacy xterm sends, which omp's input
 * parser reads from the pty. Returns null for keys the browser should keep
 * (Cmd chords, bare modifiers).
 */
const SPECIAL: Record<string, string> = {
	Enter: "\r",
	Tab: "\t",
	Backspace: "\x7f",
	Escape: "\x1b",
	ArrowUp: "\x1b[A",
	ArrowDown: "\x1b[B",
	ArrowRight: "\x1b[C",
	ArrowLeft: "\x1b[D",
	Home: "\x1b[H",
	End: "\x1b[F",
	PageUp: "\x1b[5~",
	PageDown: "\x1b[6~",
	Delete: "\x1b[3~",
	Insert: "\x1b[2~",
	F1: "\x1bOP",
	F2: "\x1bOQ",
	F3: "\x1bOR",
	F4: "\x1bOS",
	F5: "\x1b[15~",
	F6: "\x1b[17~",
	F7: "\x1b[18~",
	F8: "\x1b[19~",
	F9: "\x1b[20~",
	F10: "\x1b[21~",
	F11: "\x1b[23~",
	F12: "\x1b[24~",
};

/** xterm modifier parameter: 1 + shift + 2·alt + 4·ctrl. */
function modifier(event: KeyboardEvent): number {
	return 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
}

export function keyBytes(event: KeyboardEvent): string | null {
	if (event.metaKey) return null;
	if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return null;
	const mod = modifier(event);
	if (event.key === "Tab" && event.shiftKey) return "\x1b[Z";
	if (event.key === "Enter" && (event.shiftKey || event.altKey)) return "\x1b\r";
	const special = SPECIAL[event.key];
	if (special !== undefined) {
		if (mod > 1 && /^\x1b\[[A-DHF]$/.test(special)) return `\x1b[1;${mod}${special.at(-1)}`;
		if (mod > 1 && /^\x1b\[\d+~$/.test(special)) return special.replace("~", `;${mod}~`);
		return event.altKey && special.length === 1 ? `\x1b${special}` : special;
	}
	if (event.key.length !== 1) return null;
	let ch = event.key;
	if (event.ctrlKey) {
		const code = ch.toUpperCase().charCodeAt(0);
		if (code >= 64 && code <= 95) ch = String.fromCharCode(code - 64);
		else if (ch === " ") ch = "\x00";
		else if (ch === "/") ch = "\x1f";
	}
	return event.altKey ? `\x1b${ch}` : ch;
}
