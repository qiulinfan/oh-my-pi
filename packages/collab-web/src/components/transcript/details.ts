import type { MarkedExtension, Token, Tokens } from "@oh-my-pi/pi-utils/marked";

const OPENER = /^ {0,3}<details(\s+open)?\s*>/i;
const SUMMARY = /^\s*<summary\s*>([\s\S]*?)<\/summary\s*>/i;
const TAG = /<(\/?)details(?:\s+open)?\s*>/gi;

interface DetailsToken extends Tokens.Generic {
	open: boolean;
	summary: Token[];
	tokens: Token[];
	after: Token[];
}

/**
 * `<details>` with an optional `<summary>` in transcript Markdown, drawn as a disclosure whose summary and body are
 * Markdown; every other raw tag stays escaped. The block runs from its opener to the matching `</details>` (nested
 * ones are counted) and takes the rest of that line. One that is not closed yet, as while an answer streams, runs
 * to the end of the text and is drawn open, so its text shows as it arrives.
 */
export const detailsExtension: MarkedExtension = {
	extensions: [
		{
			name: "details",
			level: "block",
			tokenizer(src) {
				const opener = OPENER.exec(src);
				if (!opener) return undefined;
				let depth = 1;
				let close: RegExpExecArray | null = null;
				TAG.lastIndex = opener[0].length;
				for (let tag = TAG.exec(src); tag !== null; tag = TAG.exec(src)) {
					depth += tag[1] === "/" ? -1 : 1;
					if (depth === 0) {
						close = tag;
						break;
					}
				}
				let inner = src.slice(opener[0].length, close?.index);
				let raw = src;
				let trailing = "";
				if (close) {
					const closeEnd = close.index + close[0].length;
					const lineEnd = src.indexOf("\n", closeEnd);
					raw = lineEnd === -1 ? src : src.slice(0, lineEnd + 1);
					trailing = src.slice(closeEnd, lineEnd === -1 ? src.length : lineEnd).trim();
				}
				const summary = SUMMARY.exec(inner);
				if (summary) inner = inner.slice(summary[0].length);
				const token: DetailsToken = {
					type: "details",
					raw,
					open: opener[1] !== undefined || close === null,
					summary: this.lexer.inline(summary?.[1]?.trim() || "Details"),
					tokens: this.lexer.blockTokens(inner.replace(/^(?:[ \t]*\n)+|^[ \t]+/, "").trimEnd(), []),
					after: trailing ? this.lexer.blockTokens(trailing, []) : [],
				};
				return token;
			},
			renderer(token) {
				const { open, summary, tokens, after } = token as DetailsToken;
				const head = `<details class="tr-details"${open ? " open" : ""}><summary>${this.parser.parseInline(summary)}</summary>`;
				return `${head}${this.parser.parse(tokens)}</details>\n${this.parser.parse(after)}`;
			},
		},
	],
};
