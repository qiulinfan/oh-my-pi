/**
 * The view's store against the server's document. The server applies each
 * frame to its `TspDocument` and forwards only the ops it accepted; a view
 * that applies those ops must end up with the same tree and report no drift
 * (a false report closes the socket for a fresh snapshot, over and over),
 * while an op that names something the view lacks, as after a lost frame,
 * must be reported so the view resyncs instead of drifting.
 */
import { describe, expect, test } from "bun:test";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import type { TspFrame, TspNode, TspOp } from "@oh-my-pi/pi-wire";
import { SurfaceStore } from "../src/store";

const SF = "s:1";

/** What the server does with a frame from omp: apply it, and forward the ops its document accepted. */
function forward(doc: TspDocument, s: number, ops: TspOp[]): TspOp[] {
	const frame: TspFrame = { sf: SF, s, ops };
	const rejected = new Set(doc.applyFrame(frame).map(error => error.op));
	return ops.filter((_, index) => !rejected.has(index));
}

/** The store's tree in the wire shape `TspDocument.snapshot()` uses. */
function tree(store: SurfaceStore, id = SF): TspNode {
	const node = store.get(id)!;
	const out: Record<string, unknown> = { id: node.id, k: node.k };
	if (Object.keys(node.p).length > 0) out.p = { ...node.p };
	if (node.c.length > 0) out.c = node.c.map(child => tree(store, child));
	return out as TspNode;
}

const text = (id: string, value: string): TspNode => ({ id, k: "text", p: { text: value } });

describe("SurfaceStore against the server's document", () => {
	test("applies every forwarded op without reporting drift and ends with the server's tree", () => {
		const doc = new TspDocument(SF);
		const store = new SurfaceStore(SF, doc.snapshot());
		const frames: TspOp[][] = [
			[
				["add", "main", SF, null, { id: "main", k: "col" }],
				["add", "dock", SF, null, { id: "dock", k: "col" }],
				["add", "a", "main", null, text("a", "hello")],
				["add", "b", "main", null, text("b", "world")],
			],
			[
				// Rejected by the server, so never forwarded: a duplicate id, an unknown target, a splice
				// past the text, a move before a node that is not a child of the new parent.
				["add", "a", "main", null, text("a", "again")],
				["set", "nope", { tone: "error" }],
				["splice", "a", 3, 10, "!"],
				["move", "b", "dock", "a"],
				// Accepted.
				["add", "c", "main", "b", text("c", "middle")],
				["text", "a", "append", ", there"],
				["splice", "b", 0, 1, "W"],
				["set", "b", { tone: "muted" }],
				["move", "a", "dock", null],
				["focus", "a"],
				["reveal", "c", "end"],
				["settle", "c"],
			],
			[
				["set", "b", { tone: null }],
				["del", "c"],
				["text", "b", "replace", "done"],
			],
		];
		frames.forEach((ops, index) => {
			expect(store.apply(forward(doc, index + 1, ops))).toBe(true);
		});
		expect(tree(store)).toEqual(doc.snapshot());
		expect(store.focus).toBe("a");
	});

	test("reports drift when a forwarded op names a node a lost frame added", () => {
		const doc = new TspDocument(SF);
		const store = new SurfaceStore(SF, doc.snapshot());
		expect(store.apply(forward(doc, 1, [["add", "main", SF, null, { id: "main", k: "col" }]]))).toBe(true);
		// The server applied this frame, but the view never received it (a dropped send).
		forward(doc, 2, [["add", "row", "main", null, text("row", "lost")]]);
		expect(store.apply(forward(doc, 3, [["text", "row", "append", " and found"]]))).toBe(false);
		expect(store.apply(forward(doc, 4, [["add", "child", "row", null, text("child", "x")]]))).toBe(false);
		// The failed add left nothing behind for later ops to trip over.
		expect(store.get("child")).toBeUndefined();
	});
});
