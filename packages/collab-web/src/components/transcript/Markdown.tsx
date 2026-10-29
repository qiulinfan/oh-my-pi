import type { Token } from "@oh-my-pi/pi-utils/marked";
import { Marked } from "@oh-my-pi/pi-utils/marked";
import { listMayContinueAt } from "@oh-my-pi/pi-utils/marked-list";
import type { ReactNode } from "react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { escapeHtml } from "../../lib/format";
import { getHljs } from "../../tool-render/util";
import { footnoteExtension } from "./footnote";
import { mathExtension } from "./math";

function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
/** A file name with a line (`notes.txt:12`, `a.ts:3:4`), which the URL parser would read as a scheme. */
const FILE_WITH_LINE = /^[\w.-]+\.[\w-]+:\d+(?::\d+)?$/;

/**
 * The href a Markdown link may keep: web and mail links, relative paths, and `file:` links (omp writes a local path it
 * resolved as one; a page that hosts omp, such as omp gui, opens them), or null for any other scheme.
 */
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (FILE_WITH_LINE.test(trimmed)) return `./${trimmed}`;
	let protocol: string;
	try {
		// Resolve the scheme exactly as the browser will: the URL parser strips leading
		// C0 controls and embedded tab/newline that a text check would carry through.
		({ protocol } = new URL(trimmed, "https://relative.invalid/"));
	} catch {
		return null;
	}
	if (protocol === "https:" || protocol === "http:" || protocol === "mailto:" || protocol === "file:") return trimmed;
	return null; // unknown scheme (javascript:, data:, …)
}

const md = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		// A fenced block in a language the page's highlight.js knows is highlighted (omp gui and the HTML export
		// load it); otherwise it stays plain. `language-*` names the fence either way (the GUI draws `mermaid`).
		code({ text, lang }) {
			const language = lang?.match(/^\S+/)?.[0];
			const hljs = language ? getHljs() : null;
			if (!language || !hljs?.getLanguage(language)) return false;
			const body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
			return `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>\n`;
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			// Web pages open beside this one; a local path or page link stays for the host to handle.
			const target = /^(?:https?|mailto):/i.test(url) ? ' target="_blank" rel="noopener"' : "";
			return `<a href="${escapeHtml(url)}"${titleAttr}${target}>${inner}</a>`;
		},
	},
	breaks: true,
});
md.use(mathExtension);
md.use(footnoteExtension);

function renderMarkdown(text: string): string {
	try {
		return md.parse(text, { async: false });
	} catch {
		return escapeHtml(text);
	}
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * Rendered leading blocks of a streaming text: `source` is the (tab-expanded)
 * text they cover, ending on a stable block boundary, and `html` their markup.
 */
export interface FrozenMarkdownPrefix {
	readonly source: string;
	readonly html: string;
}

const NO_PREFIX: FrozenMarkdownPrefix = { source: "", html: "" };

/**
 * An own-line display-math opener. A closer appended later turns the text from
 * it on into one block across blank lines, so nothing at or past it freezes.
 */
const MATH_OPENER_LINE = /^ {0,3}(?:\$\$|\\\[)[ \t]*$/m;

/**
 * Where freezing must stop: the first own-line opener that is not already part of a closed display-math
 * block or a code block (no append changes either), or the end of `src`. One closed `$$` block early in a
 * long answer must not keep everything after it re-rendering with each update.
 */
function mathFreezeLimit(src: string, tokens: readonly Token[]): number {
	let pos = 0;
	for (const token of tokens) {
		if (token.type !== "math" && token.type !== "code") {
			const opener = MATH_OPENER_LINE.exec(token.raw);
			if (opener !== null) return pos + opener.index;
		}
		pos += token.raw.length;
	}
	return src.length;
}
/** A whitespace-only line from the sticky offset, capturing its terminator ("\n", or "" at end of text). */
const WHITESPACE_LINE = /[^\S\n]*(\n|$)/y;

/**
 * Number of leading `tokens` (lexed from `src`) that end on a stable block
 * boundary: a blank-line break that no append to `src` can move, so that
 * `lex(src) = lex(head) ++ lex(tail)` for the current text and every
 * append-only extension of it. 0 when there is none.
 */
function stableTokenCount(src: string, tokens: readonly Token[]): { count: number; end: number } {
	const mathLimit = mathFreezeLimit(src, tokens);
	let pos = 0;
	let count = 0;
	let end = 0;
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i]!.raw;
		const tokenEnd = pos + raw.length;
		if (tokenEnd > mathLimit) break;
		// The break must be followed by real block content: at end of text the
		// next line is unknown; a leading space or newline, or a line of other
		// whitespace, joins the blank run in front of the cut.
		if (raw.endsWith("\n\n") && tokenEnd < src.length) {
			const next = src.charCodeAt(tokenEnd);
			WHITESPACE_LINE.lastIndex = tokenEnd;
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (
				next !== 0x20 &&
				next !== 0x0a &&
				WHITESPACE_LINE.exec(src) === null &&
				(prev?.type !== "list" || !listMayContinueAt(src, tokenEnd, prev.raw))
			) {
				count = i + 1;
				end = tokenEnd;
			}
		}
		pos = tokenEnd;
	}
	return { count, end };
}

/**
 * Renders streaming Markdown `text`, reusing `prefix` (the result of the
 * previous call for an earlier version of the text) when `text` extends it.
 * Only the text after the prefix is lexed and parsed; blocks of it that end on
 * a stable boundary join the returned prefix. The markup equals
 * `md.parse(text)` byte for byte: anything the split cannot reproduce exactly
 * (reference definitions, carriage returns) renders the whole text instead.
 */
export function renderStreamingMarkdown(
	text: string,
	prefix: FrozenMarkdownPrefix,
): { html: string; prefix: FrozenMarkdownPrefix } {
	// `\r` rewrites line structure under marked's normalization; bail out.
	if (text.includes("\r")) return { html: renderMarkdown(text), prefix: NO_PREFIX };
	// Tabs expand to four spaces (as marked's own normalization does), so token
	// raws tile `src` exactly.
	const src = text.includes("\t") ? text.replaceAll("\t", "    ") : text;
	const base = src.length > prefix.source.length && src.startsWith(prefix.source) ? prefix : NO_PREFIX;
	const rest = base.source.length === 0 ? src : src.slice(base.source.length);
	try {
		const tokens = md.lexer(rest);
		// A reference definition resolves links anywhere, including the frozen
		// prefix, which was lexed without it; with no prefix, `tokens` already
		// lexed the whole text with its definitions.
		for (const _label in tokens.links) {
			return { html: base === NO_PREFIX ? md.parser(tokens) : renderMarkdown(text), prefix: NO_PREFIX };
		}
		const { count, end } = stableTokenCount(rest, tokens);
		if (count === 0) return { html: base.html + md.parser(tokens), prefix: base };
		const frozen: FrozenMarkdownPrefix = {
			source: src.slice(0, base.source.length + end),
			html: base.html + md.parser(tokens.slice(0, count)),
		};
		return { html: frozen.html + md.parser(tokens.slice(count)), prefix: frozen };
	} catch {
		return { html: renderMarkdown(text), prefix: NO_PREFIX };
	}
}

/** What a {@link StreamingMarkdown} block's DOM holds: the frozen prefix's markup, drawn as its first `nodes` children. */
interface DrawnPrefix {
	html: string;
	nodes: number;
}

let inertDocument: Document | undefined;

/**
 * The prefix's share of `el`, which holds `prefix` then `tail` drawn together: all its nodes but the tail's,
 * counted by parsing only the (short) tail in an inert document, so mounting a long settled block builds
 * its DOM once and loads nothing twice. Unknown (null) when the tail starts with text, which the drawn DOM
 * may have merged into the prefix's last text node; the first update then redraws the block once.
 */
function countDrawnPrefix(el: HTMLElement, prefix: string, tail: string): DrawnPrefix | null {
	if (prefix === "") return { html: "", nodes: 0 };
	if (tail === "") return { html: prefix, nodes: el.childNodes.length };
	inertDocument ??= document.implementation.createHTMLDocument("");
	const parsed = inertDocument.createElement("div");
	parsed.innerHTML = tail;
	if (parsed.firstChild?.nodeType === Node.TEXT_NODE) return null;
	const nodes = el.childNodes.length - parsed.childNodes.length;
	return nodes < 0 ? null : { html: prefix, nodes };
}

/**
 * {@link Markdown} for a block that is still streaming: settled leading
 * blocks are rendered once and reused, so each token re-parses only the open
 * tail instead of the whole growing block. Their DOM is kept too: an update
 * appends what newly froze and replaces only the tail's nodes, so the browser
 * builds and lays out the tail and not the whole answer again (a 68k-character
 * answer cost ~7 ms per update rebuilt whole). The DOM is the one {@link Markdown}
 * draws for the same text: the prefix ends on a block boundary, so its markup
 * and the tail's parse to the same top-level nodes apart or together.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }): ReactNode {
	const prefixRef = useRef(NO_PREFIX);
	const rendered = useMemo(() => {
		const result = renderStreamingMarkdown(text, prefixRef.current);
		prefixRef.current = result.prefix;
		return result;
	}, [text]);
	// The first markup goes in as React's (so server rendering draws it); React never sets it again, since
	// this prop stays the same object, and every later update is drawn by the effect below.
	const [initial] = useState(() => ({ __html: rendered.html }));
	const ref = useRef<HTMLDivElement>(null);
	// Unknown until counted: on mount from what React drew, else by the first update, which redraws once.
	const drawn = useRef<DrawnPrefix | null>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const { html, prefix } = rendered;
		const at = drawn.current;
		if (at === null && html === initial.__html) {
			drawn.current = countDrawnPrefix(el, prefix.html, html.slice(prefix.html.length));
			return;
		}
		if (at === null || !prefix.html.startsWith(at.html) || el.childNodes.length < at.nodes) {
			el.innerHTML = prefix.html;
			drawn.current = { html: prefix.html, nodes: el.childNodes.length };
			el.insertAdjacentHTML("beforeend", html.slice(prefix.html.length));
			return;
		}
		while (el.childNodes.length > at.nodes) el.lastChild!.remove();
		if (prefix.html.length > at.html.length) {
			el.insertAdjacentHTML("beforeend", prefix.html.slice(at.html.length));
			drawn.current = { html: prefix.html, nodes: el.childNodes.length };
		}
		el.insertAdjacentHTML("beforeend", html.slice(prefix.html.length));
	}, [rendered, initial]);
	return <div className="tr-md" ref={ref} dangerouslySetInnerHTML={initial} />;
});
