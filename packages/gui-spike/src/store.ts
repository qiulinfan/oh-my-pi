/**
 * Browser-side surface document: the TSP ops applied to mutable nodes, each
 * with a version that bumps on change, so a React component re-renders only
 * when its own node changed (props, text or its child list).
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

	constructor(id: string, root?: TspNode) {
		this.id = id;
		this.nodes.set(id, { id, k: "col", p: {}, c: [], parent: null, v: 0 });
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

	apply(ops: readonly TspOp[]): void {
		for (const op of ops) {
			try {
				this.#apply(op);
			} catch (error) {
				console.warn("tsp op failed", op, error);
			}
		}
		for (const id of this.#pending) {
			for (const listener of this.#listeners.get(id) ?? []) listener();
		}
		this.#pending.clear();
	}

	#touch(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.v++;
		this.#pending.add(id);
	}

	#build(wire: TspNode, parent: string, before: string | null): void {
		const node: StoreNode = { id: wire.id, k: wire.k, p: { ...wire.p }, c: [], parent, v: 0 };
		this.nodes.set(node.id, node);
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

	#apply(op: TspOp): void {
		switch (op[0]) {
			case "add": {
				const [, id, parent, before, wire] = op;
				if (this.nodes.has(id)) this.#detach(id);
				this.#build({ ...wire, id }, parent, before);
				this.#touch(parent);
				return;
			}
			case "set": {
				const [, id, props] = op;
				const node = this.nodes.get(id);
				if (!node) return;
				const next = { ...node.p };
				for (const key in props) {
					const value = props[key];
					if (value === null) delete next[key];
					else if (value !== undefined) next[key] = value;
				}
				node.p = next;
				this.#touch(id);
				return;
			}
			case "text": {
				const [, id, mode, text] = op;
				const node = this.nodes.get(id);
				if (!node) return;
				node.p = { ...node.p, text: mode === "append" ? `${node.p.text ?? ""}${text}` : text };
				this.#touch(id);
				return;
			}
			case "splice": {
				const [, id, at, del, text] = op;
				const node = this.nodes.get(id);
				if (!node) return;
				const current: string = node.p.text ?? "";
				node.p = { ...node.p, text: current.slice(0, at) + text + current.slice(at + del) };
				this.#touch(id);
				return;
			}
			case "move": {
				const [, id, parent, before] = op;
				const node = this.nodes.get(id);
				const target = this.nodes.get(parent);
				if (!node || !target) return;
				this.#detach(id, false);
				const at = before === null ? -1 : target.c.indexOf(before);
				if (at === -1) target.c.push(id);
				else target.c.splice(at, 0, id);
				node.parent = parent;
				this.#touch(parent);
				return;
			}
			case "del": {
				const [, id] = op;
				this.#detach(id);
				return;
			}
			case "focus": {
				this.focus = op[1];
				this.focusVersion++;
				this.#touch(this.id);
				if (op[1]) this.#touch(op[1]);
				return;
			}
			case "reveal": {
				this.reveal = { id: op[1], n: (this.reveal?.n ?? 0) + 1 };
				this.#touch(this.id);
				return;
			}
			default:
				return;
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
