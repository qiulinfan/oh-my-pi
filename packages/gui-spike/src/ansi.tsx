/**
 * Minimal ANSI renderer for `ansi` and `rows` nodes: SGR colours and
 * attributes, OSC 8 links, `\r` overwrite; everything else is dropped.
 */
import type { CSSProperties, ReactNode } from "react";

function color256(n: number): string {
	// The 16 base colours follow the theme (styles.css --ansi-0…15) so output stays legible on paper and charcoal.
	if (n < 16) return `var(--ansi-${n})`;
	if (n < 232) {
		const i = n - 16;
		const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
		return `rgb(${v(Math.floor(i / 36))},${v(Math.floor(i / 6) % 6)},${v(i % 6)})`;
	}
	const g = 8 + (n - 232) * 10;
	return `rgb(${g},${g},${g})`;
}

interface Style {
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	inverse?: boolean;
	href?: string;
}

function applySgr(style: Style, params: number[]): Style {
	const next = { ...style };
	if (params.length === 0) params = [0];
	for (let i = 0; i < params.length; i++) {
		const p = params[i]!;
		if (p === 0) {
			const href = next.href;
			for (const key of Object.keys(next)) delete (next as any)[key];
			if (href) next.href = href;
		} else if (p === 1) next.bold = true;
		else if (p === 2) next.dim = true;
		else if (p === 3) next.italic = true;
		else if (p === 4) next.underline = true;
		else if (p === 7) next.inverse = true;
		else if (p === 9) next.strike = true;
		else if (p === 22) next.bold = next.dim = false;
		else if (p === 23) next.italic = false;
		else if (p === 24) next.underline = false;
		else if (p === 27) next.inverse = false;
		else if (p === 29) next.strike = false;
		else if (p >= 30 && p <= 37) next.fg = color256(p - 30);
		else if (p >= 90 && p <= 97) next.fg = color256(p - 90 + 8);
		else if (p >= 40 && p <= 47) next.bg = color256(p - 40);
		else if (p >= 100 && p <= 107) next.bg = color256(p - 100 + 8);
		else if (p === 39) delete next.fg;
		else if (p === 49) delete next.bg;
		else if (p === 38 || p === 48) {
			const mode = params[i + 1];
			let value: string | undefined;
			if (mode === 5) {
				value = color256(params[i + 2] ?? 0);
				i += 2;
			} else if (mode === 2) {
				value = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
				i += 4;
			}
			if (value) {
				if (p === 38) next.fg = value;
				else next.bg = value;
			}
		}
	}
	return next;
}

function cssOf(style: Style): CSSProperties {
	const fg = style.inverse ? style.bg : style.fg;
	const bg = style.inverse ? (style.fg ?? "var(--fg)") : style.bg;
	return {
		color: fg,
		background: bg,
		fontWeight: style.bold ? 600 : undefined,
		opacity: style.dim ? 0.6 : undefined,
		fontStyle: style.italic ? "italic" : undefined,
		textDecoration:
			[style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ") ||
			undefined,
	};
}

/** One line of ANSI text (no newlines) as styled spans. */
export function ansiLine(line: string, key?: string | number): ReactNode {
	const parts: ReactNode[] = [];
	let style: Style = {};
	let text = "";
	let n = 0;
	const flush = () => {
		if (!text) return;
		const content = style.href ? (
			<a key={n++} href={style.href} target="_blank" rel="noreferrer" style={cssOf(style)}>
				{text}
			</a>
		) : (
			<span key={n++} style={cssOf(style)}>
				{text}
			</span>
		);
		parts.push(content);
		text = "";
	};
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === "\x1b") {
			const rest = line.slice(i);
			const csi = /^\x1b\[([0-9;:]*)([A-Za-z])/.exec(rest);
			if (csi) {
				if (csi[2] === "m") {
					flush();
					style = applySgr(style, csi[1]!.split(/[;:]/).filter(Boolean).map(Number));
				}
				i += csi[0].length - 1;
				continue;
			}
			const osc = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(\x07|\x1b\\)/.exec(rest);
			if (osc) {
				flush();
				style = { ...style, href: osc[1] || undefined };
				i += osc[0].length - 1;
				continue;
			}
			const other = /^\x1b(\][^\x07\x1b]*(\x07|\x1b\\)|.)/.exec(rest);
			i += (other?.[0].length ?? 1) - 1;
			continue;
		}
		if (ch === "\r") {
			flush();
			parts.length = 0;
			continue;
		}
		if (ch === "\b") {
			text = text.slice(0, -1);
			continue;
		}
		text += ch;
	}
	flush();
	return (
		<div className="ansi-line" key={key}>
			{parts.length > 0 ? parts : " "}
		</div>
	);
}

export function AnsiBlock({ text, className }: { text: string; className?: string }): ReactNode {
	return <div className={`ansi ${className ?? ""}`}>{text.split("\n").map((line, i) => ansiLine(line, i))}</div>;
}
