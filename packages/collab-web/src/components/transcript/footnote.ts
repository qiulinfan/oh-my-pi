import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import { escapeHtml } from "../../lib/format";

// `[^label]: text`, continued by indented lines. Without this rule the line reads as a link reference definition,
// and every `[^label]` turns into a link to its text.
const DEFINITION = /^ {0,3}\[\^([^\]\s]{1,64})\]:[ \t]*([^\n]*(?:\n(?: {2,}|\t)[^\n]*)*)(?:\n|$)/;
// A reference that is not the text of a link (`[^x](url)`, `[^x][ref]`).
const REFERENCE = /^\[\^([^\]\s]{1,64})\](?![([])/;

/**
 * GFM footnotes in transcript Markdown: `[^label]` draws as a superscript label, and its `[^label]: text` definition
 * as a footnote line where it was written (an answer puts them at its end). Labels are not linked to their notes:
 * one page holds many messages, which may reuse a label.
 */
export const footnoteExtension: MarkedExtension = {
	extensions: [
		{
			name: "footnoteDefinition",
			level: "block",
			tokenizer(src) {
				const match = DEFINITION.exec(src);
				if (!match) return undefined;
				const text = match[2]!.replace(/\n(?: {2,}|\t)/g, "\n").trim();
				return {
					type: "footnoteDefinition",
					raw: match[0],
					label: match[1]!,
					text,
					tokens: this.lexer.inline(text),
				};
			},
			renderer(token) {
				const { label, tokens } = token as Tokens.Generic & { label: string; tokens: Tokens.Generic[] };
				return `<p class="tr-footnote"><sup>${escapeHtml(label)}</sup> ${this.parser.parseInline(tokens)}</p>\n`;
			},
		},
		{
			name: "footnoteReference",
			level: "inline",
			startFrom(src, from) {
				const at = src.indexOf("[^", from);
				return at === -1 ? undefined : at;
			},
			tokenizer(src) {
				const match = REFERENCE.exec(src);
				if (!match) return undefined;
				return { type: "footnoteReference", raw: match[0], label: match[1]! };
			},
			renderer(token) {
				return `<sup class="tr-footnote-ref">${escapeHtml(String(token.label))}</sup>`;
			},
		},
	],
};
