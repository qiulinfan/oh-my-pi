/**
 * Browser-side surface document: the TSP ops applied to mutable nodes, each
 * with a version that bumps on change, so a React component re-renders only
 * when its own node changed (props, text or its child list).
 *
 * The server forwards only the ops its own document accepted, so an op this
 * store cannot apply (a node, parent or sibling it lacks, a splice past the
 * text) means the store has drifted from the server's document: `apply`
 * reports it and the connection asks for a fresh snapshot.
 */
import type { TspNode, TspOp } from "@oh-my-pi/pi-wire";

export interface StoreNode {
	id: string;
	k: string;
	p: Record<string, any>;
	c: string[];
	parent: string | null;
	v: number;
}

type Listener = () => void;

export class SurfaceStore {
	readonly id: string;
	readonly nodes = new Map<string, StoreNode>();
	focus: string | null = null;
	/** Bumps when focus changes or a `reveal` arrives. */
	focusVersion = 0;
	reveal: { id: string; n: number } | null = null;
	#listeners = new Map<string, Set<Listener>>();
	#pending = new Set<string>();
	/**
	 * Store-wide version clock. Every built or changed node takes the next value, so a node the
	 * server deletes and re-adds under the same id (a settled component's changed child) never
	 * comes back with a version a mounted view already rendered.
	 */
	#clock = 0;

	constructor(id: string, root?: TspNode) {
		this.id = id;
		this.nodes.set(id, { id, k: "col", p: { ...root?.p }, c: [], parent: null, v: ++this.#clock });
		if (root) for (const child of root.c ?? []) this.#build(child, id, null);
	}

	subscribe(id: string, listener: Listener): () => void {
		let set = this.#listeners.get(id);
		if (!set) {
			set = new Set();
			this.#listeners.set(id, set);
		}
		set.add(listener);
		return () => set!.delete(listener);
	}

	get(id: string): StoreNode | undefined {
		return this.nodes.get(id);
	}

	/** Text of a node and its descendants, for copy actions. */
	textOf(id: string): string {
		const node = this.nodes.get(id);
		if (!node) return "";
		const own =
			typeof node.p.text === "string"
				? node.p.text
				: Array.isArray(node.p.spans)
					? node.p.spans.map((s: any) => s.t).join("")
					: "";
		const kids = node.c.map(child => this.textOf(child)).filter(Boolean);
		return [own, ...kids].filter(Boolean).join(node.k === "row" ? " " : "\n");
	}

	/** Apply a frame's ops; false when one of them did not fit this document (see the module comment). */
	apply(ops: readonly TspOp[]): boolean {
		let fits = true;
		for (const op of ops) {
			try {
				if (!this.#apply(op)) fits = false;
			} catch (error) {
				console.warn("tsp op failed", op, error);
				fits = false;
			}
		}
		for (const id of this.#pending) {
			for (const listener of this.#listeners.get(id) ?? []) listener();
		}
		this.#pending.clear();
		return fits;
	}

	#touch(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.v = ++this.#clock;
		this.#pending.add(id);
	}

	#build(wire: TspNode, parent: string, before: string | null): void {
		const node: StoreNode = { id: wire.id, k: wire.k, p: { ...wire.p }, c: [], parent, v: ++this.#clock };
		this.nodes.set(node.id, node);
		// Listeners stay keyed by id across a removal, so a view still mounted for a re-added id redraws.
		this.#pending.add(node.id);
		const parentNode = this.nodes.get(parent)!;
		const at = before === null ? -1 : parentNode.c.indexOf(before);
		if (at === -1) parentNode.c.push(node.id);
		else parentNode.c.splice(at, 0, node.id);
		for (const child of wire.c ?? []) this.#build(child, node.id, null);
	}

	#remove(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		for (const child of node.c) this.#remove(child);
		this.nodes.delete(id);
		if (this.focus === id) this.focus = null;
	}

	/** Whether `before` is null or a child of `parent`, as the server's applier requires. */
	#slot(parent: string, before: string | null): boolean {
		return before === null || this.nodes.get(before)?.parent === parent;
	}

	#apply(op: TspOp): boolean {
		switch (op[0]) {
			case "add": {
				const [, id, parent, before, wire] = op;
				if (!this.nodes.has(parent) || !this.#slot(parent, before)) return false;
				// The server refuses an id it already holds, so one this store holds is drift; replace it all the same.
				const fresh = !this.nodes.has(id);
				if (!fresh) this.#detach(id);
				this.#build({ ...wire, id }, parent, before);
				this.#touch(parent);
				return fresh;
			}
			case "set": {
				const [, id, props] = op;
				const node = this.nodes.get(id);
				if (!node) return false;
				const next = { ...node.p };
				for (const key in props) {
					const value = props[key];
					if (value === null) delete next[key];
					else if (value !== undefined) next[key] = value;
				}
				node.p = next;
				this.#touch(id);
				return true;
			}
			case "text": {
				const [, id, mode, text] = op;
				const node = this.nodes.get(id);
				if (!node) return false;
				const current: string = typeof node.p.text === "string" ? node.p.text : "";
				node.p = { ...node.p, text: mode === "append" ? current + text : text };
				this.#touch(id);
				return true;
			}
			case "splice": {
				const [, id, at, del, text] = op;
				const node = this.nodes.get(id);
				if (!node) return false;
				const current: string = typeof node.p.text === "string" ? node.p.text : "";
				if (at < 0 || del < 0 || at + del > current.length) return false;
				node.p = { ...node.p, text: current.slice(0, at) + text + current.slice(at + del) };
				this.#touch(id);
				return true;
			}
			case "move": {
				const [, id, parent, before] = op;
				const node = this.nodes.get(id);
				const target = this.nodes.get(parent);
				if (!node || !target || !this.#slot(parent, before)) return false;
				this.#detach(id, false);
				const at = before === null ? -1 : target.c.indexOf(before);
				if (at === -1) target.c.push(id);
				else target.c.splice(at, 0, id);
				node.parent = parent;
				this.#touch(parent);
				return true;
			}
			case "del": {
				const [, id] = op;
				if (!this.nodes.has(id)) return false;
				this.#detach(id);
				return true;
			}
			case "focus": {
				const [, id] = op;
				if (id !== null && !this.nodes.has(id)) return false;
				this.focus = id;
				this.focusVersion++;
				this.#touch(this.id);
				if (id) this.#touch(id);
				return true;
			}
			case "reveal": {
				if (!this.nodes.has(op[1])) return false;
				this.reveal = { id: op[1], n: (this.reveal?.n ?? 0) + 1 };
				this.#touch(this.id);
				return true;
			}
			case "settle":
			case "scroll":
				return this.nodes.has(op[1]);
			default:
				return true;
		}
	}

	/** Unlink a node from its parent; `drop` also forgets the subtree. */
	#detach(id: string, drop = true): void {
		const node = this.nodes.get(id);
		if (!node || node.parent === null) return;
		const parent = this.nodes.get(node.parent);
		if (parent) {
			parent.c = parent.c.filter(child => child !== id);
			this.#touch(parent.id);
		}
		if (drop) this.#remove(id);
	}
}
