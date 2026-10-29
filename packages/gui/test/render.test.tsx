/**
 * Disclosures as the page draws them. Opening a row whose children clamp themselves (bash, eval, wait
 * and execution cards send `preview: "children"`) must show their whole output, since omp sends the
 * same child preview either way; a plain container or a collapsed row inside an open one keeps the
 * clamp. A head toggles from the keyboard without its key reaching omp's prompt.
 */
import { describe, expect, mock, test } from "bun:test";
import type { TspNode } from "@oh-my-pi/pi-wire";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { disclosureHead, N, SurfaceContext, Transcript } from "../src/render";
import type { SessionConnection } from "../src/session";
import { SurfaceStore } from "../src/store";

const SF = "s:1";
const OUTPUT = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
const ansi = (id: string): TspNode => ({ id, k: "ansi", p: { text: OUTPUT, follow: true, preview: { lines: 10 } } });

/** A bash-like row: a finished tool whose only body is an ansi output that clamps itself. */
function tool(p: { collapsible: boolean; collapsed?: boolean }, child: TspNode = ansi("t.out")): TspNode {
	return {
		id: "t",
		k: "tool",
		p: { name: "bash", title: "Bash", status: "done", preview: "children", ...p },
		c: [child],
	};
}

function draw(node: TspNode): string {
	const store = new SurfaceStore(SF, { id: SF, k: "col", c: [node] });
	const session = {} as unknown as SessionConnection;
	return renderToStaticMarkup(
		<SurfaceContext.Provider value={{ store, sf: SF, session }}>
			<N id={node.id} />
		</SurfaceContext.Provider>,
	);
}

describe("disclosure bodies", () => {
	test("a collapsed row keeps its output clamped; opening it shows all of it", () => {
		const collapsed = draw(tool({ collapsible: true, collapsed: true }));
		expect(collapsed).toContain("Show all");
		expect(collapsed).toContain('aria-expanded="false"');

		const open = draw(tool({ collapsible: true, collapsed: false }));
		expect(open).not.toContain("Show all");
		expect(open).not.toContain('class="clamp');
		expect(open).toContain("line 20");
		expect(open).toContain('aria-expanded="true"');
	});

	test("a row that cannot collapse keeps its children's clamps", () => {
		const html = draw(tool({ collapsible: false }));
		expect(html).toContain("Show all");
		expect(html).not.toContain('role="button"');
	});

	test("a collapsed card inside an open row clamps its output again", () => {
		const card: TspNode = {
			id: "c",
			k: "card",
			p: { collapsible: true, collapsed: true, preview: { lines: 3 } },
			c: [ansi("c.out")],
		};
		expect(draw(tool({ collapsible: true, collapsed: false }, card))).toContain("Show all");
	});

	test("an open subagent inside a collapsed task row shows its output in full", () => {
		const agent: TspNode = {
			id: "a",
			k: "agent",
			p: { name: "explore", status: "done", collapsible: true, collapsed: false },
			c: [ansi("a.out")],
		};
		const html = draw(tool({ collapsible: true, collapsed: true }, agent));
		expect(html).not.toContain("Show all");
		expect(html).toContain("line 20");
	});
});

/** A keydown on a head, as React hands it to the handler. */
function key(init: { key: string; shiftKey?: boolean; repeat?: boolean; fromChild?: boolean }) {
	const head = {};
	const event = {
		key: init.key,
		target: init.fromChild ? {} : head,
		currentTarget: head,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: init.shiftKey ?? false,
		repeat: init.repeat ?? false,
		nativeEvent: { isComposing: false },
		preventDefault: mock(() => {}),
		stopPropagation: mock(() => {}),
	};
	return event;
}

describe("disclosure heads from the keyboard", () => {
	test("Enter and Space toggle the row and stop there, so omp's prompt never gets them", () => {
		for (const name of ["Enter", " "]) {
			const toggle = mock(() => {});
			const event = key({ key: name });
			disclosureHead(true, toggle).onKeyDown!(event as unknown as KeyboardEvent<HTMLElement>);
			expect(toggle).toHaveBeenCalledTimes(1);
			expect(event.stopPropagation).toHaveBeenCalled();
			expect(event.preventDefault).toHaveBeenCalled();
		}
	});

	test("other keys, chords, repeats and keys from inside the head leave the row alone", () => {
		for (const init of [
			{ key: "a" },
			{ key: "Enter", shiftKey: true },
			{ key: " ", repeat: true },
			{ key: "Enter", fromChild: true },
		]) {
			const toggle = mock(() => {});
			const event = key(init);
			disclosureHead(false, toggle).onKeyDown!(event as unknown as KeyboardEvent<HTMLElement>);
			expect(toggle).not.toHaveBeenCalled();
			expect(event.stopPropagation).not.toHaveBeenCalled();
		}
	});
});

// omp sends eval's printed JSON as a `json` node; without a renderer the page drew an empty box.
describe("json", () => {
	const value = {
		name: "omp",
		nested: { list: Array.from({ length: 30 }, (_, i) => `item-${i}`) },
		small: [1, 2],
	};

	test("lists the root's entries, folds long containers below them, and keeps short ones on one line", () => {
		const html = draw({ id: "j", k: "json", p: { value } });
		expect(html).toContain('<details class="json-node" open="">');
		expect(html).toContain("&quot;omp&quot;");
		expect(html).toContain("[1,2]");
		// `nested` and the long `list` inside it start folded.
		expect(html.match(/<details class="json-node">/g)?.length).toBe(2);
	});

	test("open: 1 also opens the containers one level down", () => {
		const html = draw({ id: "j", k: "json", p: { value, open: 1 } });
		expect(html.match(/<details class="json-node" open="">/g)?.length).toBe(2);
		expect(html).toContain("item-29");
	});
});

// The answer used to sit on the timeline rail with the work; it belongs at full width, between runs of work.
describe("turns", () => {
	const md = (id: string, text: string): TspNode => ({ id, k: "md", p: { text } });
	const thought: TspNode = { id: "a1.think", k: "section", p: { role: "omp.thinking", title: "Thought" }, c: [] };

	test("thinking and tools ride the rail; the assistant's prose sits between them off it", () => {
		const main: TspNode = {
			id: "main",
			k: "col",
			c: [
				{ id: "u", k: "md", p: { role: "omp.user", text: "explain" } },
				{ id: "a1", k: "col", p: { role: "omp.assistant" }, c: [thought, md("a1.text", "First, a look.")] },
				tool({ collapsible: true, collapsed: true }),
				{ id: "a2", k: "col", p: { role: "omp.assistant" }, c: [md("a2.text", "The answer.")] },
			],
		};
		const store = new SurfaceStore(SF, { id: SF, k: "col", c: [main] });
		const html = renderToStaticMarkup(
			<SurfaceContext.Provider value={{ store, sf: SF, session: {} as unknown as SessionConnection }}>
				<Transcript id="main" />
			</SurfaceContext.Provider>,
		);
		const blocks = Array.from(html.matchAll(/<div class="(steps|answer)">/g), match => match[1]);
		expect(blocks).toEqual(["steps", "answer", "steps", "answer"]);
		const [, rail, first, , second] = html.split(/<div class="(?:steps|answer)">/);
		expect(rail).toContain("Thought");
		expect(first).toContain("First, a look.");
		expect(second).toContain("The answer.");
	});
});
