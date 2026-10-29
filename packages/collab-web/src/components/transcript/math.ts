import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import {
	type MathSpan,
	mathBlockInContext,
	mathSpanInContext,
	mathStartIndex,
} from "@oh-my-pi/pi-utils/math-delimiters";
import { renderToString } from "katex";
import { escapeHtml } from "../../lib/format";

/**
 * A backtick between the delimiters means the run is prose that merely looks
 * like math (`$x `code` y$`): KaTeX cannot express a code span, so typesetting
 * would swallow it and print an error instead.
 */
function typesettable(span: MathSpan): boolean {
	return !span.body.includes("`");
}

/**
 * KaTeX's output for transcript math. MathML alone needs no stylesheet, but Chromium's MathML Core ignores
 * `mathvariant`, so `\\mathbb{R}` and `\\mathcal{L}` draw as plain letters there; a page that loads
 * `katex.min.css` (omp gui) switches to KaTeX's HTML, with the MathML kept for screen readers.
 */
let katexOutput: "mathml" | "htmlAndMathml" = "mathml";

/** Draw transcript math with KaTeX's HTML; call once at startup on a page that loads `katex.min.css`. */
export function drawMathWithKatexHtml(): void {
	katexOutput = "htmlAndMathml";
}

function renderMath(token: Tokens.Generic): string | false {
	if (token.type !== "math" || typeof token.text !== "string" || typeof token.display !== "boolean") return false;
	try {
		const math = renderToString(token.text, {
			displayMode: token.display,
			// KaTeX's HTML output needs katex.min.css, which bundles to ~940 KB
			// gzipped here because Bun inlines its 60 @font-face sources (see katexOutput).
			output: katexOutput,
			throwOnError: false,
			// `trust: false` refuses \href, \htmlClass, \includegraphics.
			strict: false,
			trust: false,
		});
		// A display equation gets a wrapper to scroll in (`.tr-math`), because
		// scrolling the `math` element itself traps a few pixels of vertical scroll:
		// its ink — fraction bars, radical overlines — overflows its own box.
		return token.display ? `<span class="tr-math">${math}</span>` : math;
	} catch {
		// KaTeX threw outside its own error handling (e.g. macro expansion limit):
		// show the source rather than let one span blank the whole message.
		return escapeHtml(typeof token.raw === "string" ? token.raw : token.text);
	}
}

/**
 * Renders LaTeX in transcript Markdown: `$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Delimiters and the
 * scan hint come from `@oh-my-pi/pi-utils/math-delimiters`, so this renderer and
 * the TUI agree on what counts as math; only presentation policy lives here.
 *
 * One limit follows from that shared behavior, matching the TUI: a display block
 * whose body contains a blank line must be preceded by one — attached blocks are
 * tokenized by the inline rule, which a blank line ends.
 */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			// No `start` hint: this parser probes block extensions only at a block
			// boundary and never consults their hints.
			tokenizer(source) {
				const block = mathBlockInContext(this, source);
				if (!block) return undefined;
				return { type: "math", raw: block.raw, text: block.body, display: true };
			},
			renderer: renderMath,
		},
		{
			name: "math",
			level: "inline",
			startFrom: mathStartIndex,
			tokenizer(source) {
				const span = mathSpanInContext(this, source);
				if (!span || !typesettable(span)) return undefined;
				return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
			},
			renderer: renderMath,
		},
	],
};
