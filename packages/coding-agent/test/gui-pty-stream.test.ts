/**
 * Contract tests for how the GUI server reads omp's terminal output: a message cut off by another
 * escape never swallows the message after it, an escape string that never ends is dropped without
 * holding the stream, and the plain text between sequences becomes the tail an ended view shows.
 */
import { describe, expect, test } from "bun:test";
import { OUTPUT_TAIL_LINES, OutputTail, PtyStream, type PtyStreamSink } from "../src/gui/pty-stream";

const ESC = "\x1b";
const ST = `${ESC}\\`;

/** Everything a stream reports, in order. */
function recorder(): { sink: PtyStreamSink; events: string[] } {
	const events: string[] = [];
	return {
		events,
		sink: {
			string: (kind, body) => events.push(`string ${kind} ${body}`),
			csi: (prefix, params, final) => events.push(`csi ${prefix}${params}${final}`),
			text: text => events.push(`text ${text}`),
			dropped: (kind, reason) => events.push(`dropped ${kind} ${reason}`),
		},
	};
}

const encoder = new TextEncoder();

function feed(stream: PtyStream, ...chunks: string[]): void {
	for (const chunk of chunks) stream.write(encoder.encode(chunk));
}

describe("gui PTY stream", () => {
	test("a sequence cut off by another escape is dropped and the message after it is read whole", () => {
		const { sink, events } = recorder();
		const stream = new PtyStream(sink);
		// A stray APC introducer with no terminator, then a real frame; a CSI cut short, then a title report.
		feed(
			stream,
			`${ESC}_tsp;f;{"sf":"s:1"`,
			`${ESC}_tsp;f;{"sf":"s:1","s":2}${ST}`,
			`${ESC}[3`,
			`${ESC}]2;title\x07`,
		);
		expect(events).toEqual(["dropped _ cut-off", 'string _ tsp;f;{"sf":"s:1","s":2}', "string ] 2;title"]);
	});

	test("tmux's passthrough is one string: the escapes it doubles cut nothing off and leak no text", () => {
		const { sink, events } = recorder();
		const stream = new PtyStream(sink);
		const wrapped = `tmux;${ESC}${ESC}]9;Task finished${ESC}${ESC}\\`;
		feed(stream, `${ESC}P${wrapped}`, `${ST}after`);
		expect(events).toEqual([`string P ${wrapped}`, "text after"]);
	});

	test("at the end of the stream an unfinished string is dropped and what was printed past its line reaches the text", () => {
		const { sink, events } = recorder();
		const stream = new PtyStream(sink);
		// omp dies writing a frame and its runtime prints the error with no escape that would cut the frame off.
		const crash = "\nerror: EIO: i/o error, write\n    at flush (frame.ts:12:3)\n";
		feed(stream, `${ESC}_tsp;f;{"sf":"s:1","s":7,"ops":[`, crash);
		expect(events).toEqual([]);
		stream.end();
		expect(events).toEqual(["dropped _ unterminated", `text ${crash}`]);
	});

	test("sequences split across reads are read once, and text between them is kept apart from CSI", () => {
		const { sink, events } = recorder();
		const stream = new PtyStream(sink);
		// The terminator split between ESC and backslash, a CSI split mid-parameters, text around both.
		feed(stream, `boom ${ESC}_tsp;q;{}${ESC}`, `\\${ESC}[3`, "1mred", `${ESC}[0m done`);
		expect(events).toEqual(["text boom ", "string _ tsp;q;{}", "csi 31m", "text red", "csi 0m", "text  done"]);
	});

	test("an escape string that never ends is dropped past the cap, its rest is not taken for text", () => {
		const { sink, events } = recorder();
		const stream = new PtyStream(sink, 32);
		feed(stream, `${ESC}_tsp;b;`, "A".repeat(40), "B".repeat(40), `${ST}after${ESC}_tsp;q;{}${ST}`);
		expect(events).toEqual(["dropped _ overflow", "text after", "string _ tsp;q;{}"]);
	});
});

describe("gui output tail", () => {
	test("keeps the last lines, sanitized: controls stripped, tabs expanded, progress overwrites resolved", () => {
		const tail = new OutputTail();
		for (let i = 0; i < OUTPUT_TAIL_LINES + 10; i++) tail.push(`line ${i}\n`);
		tail.push("progress 10%\rprogress 100%\n");
		tail.push("\tError:\x07 boom\n\n");
		const lines = tail.text()!.split("\n");
		expect(lines.length).toBe(OUTPUT_TAIL_LINES);
		expect(lines.slice(-3)).toEqual([`line ${OUTPUT_TAIL_LINES + 9}`, "progress 100%", "   Error: boom"]);
	});

	test("a carriage return that ends a line overwrites nothing: CRLF through the terminal, a last status line", () => {
		const tail = new OutputTail();
		// The terminal turns the "\n" of a "\r\n" omp writes into "\r\n" again.
		tail.push("error: boom\r\r\n    at foo\r\r\n");
		tail.push("stopping\r");
		expect(tail.text()).toBe("error: boom\n    at foo\nstopping");
	});
});
