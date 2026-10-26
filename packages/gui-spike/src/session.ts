/**
 * One live omp session as seen by a browser view: the WebSocket to the
 * server, a store per surface, the palette, and blob URLs. Components read
 * it through React context and send keys/events back through it.
 */
import type { TspNode, TspOp } from "@oh-my-pi/pi-wire";
import { SurfaceStore } from "./store";

export interface SurfaceMeta {
	id: string;
	mode: "inline" | "screen";
	title?: string;
	role?: string;
	palette?: { dark?: Record<string, string>; light?: Record<string, string> };
	closed?: boolean;
}

export interface SessionInfo {
	id: string;
	cwd: string;
	args: string[];
	startedAt: number;
	exited: boolean;
	title?: string;
	busy: boolean;
}

type Listener = () => void;

/** A desktop notification when the page is hidden, else nothing (the transcript already shows it). */
function notify(title: string, body: string): void {
	if (typeof Notification === "undefined" || !document.hidden) return;
	if (Notification.permission === "granted") new Notification(title, { body });
	else if (Notification.permission !== "denied") void Notification.requestPermission();
}

export class SessionConnection {
	readonly id: string;
	info: SessionInfo | null = null;
	surfaces = new Map<string, { meta: SurfaceMeta; store: SurfaceStore }>();
	blobs = new Map<string, string>();
	exited = false;
	connected = false;
	/** Bumps on surface open/close/palette/exit: the session shell re-renders. */
	version = 0;
	#ws: WebSocket | null = null;
	#listeners = new Set<Listener>();
	#token: string;

	constructor(id: string, token: string) {
		this.id = id;
		this.#token = token;
		this.#connect();
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		this.version++;
		for (const listener of this.#listeners) listener();
	}

	#connect(): void {
		const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/pty?id=${this.id}&t=${this.#token}`);
		this.#ws = ws;
		ws.onopen = () => {
			this.connected = true;
			this.#changed();
		};
		ws.onclose = () => {
			this.connected = false;
			this.#changed();
			if (!this.exited) setTimeout(() => this.#connect(), 1000);
		};
		ws.onmessage = event => this.#onMessage(JSON.parse(String(event.data)));
	}

	#onMessage(message: any): void {
		switch (message.t) {
			case "init":
				this.info = message.session;
				this.exited = message.session.exited;
				this.surfaces.clear();
				for (const surface of message.surfaces as (SurfaceMeta & { root: TspNode })[]) {
					const { root, ...meta } = surface;
					this.surfaces.set(meta.id, {
						meta: { ...meta, palette: (meta as any).palette },
						store: new SurfaceStore(meta.id, root),
					});
				}
				this.blobs = new Map(Object.entries(message.blobs ?? {}));
				this.#changed();
				return;
			case "open": {
				const { root, ...meta } = message.surface as SurfaceMeta & { root: TspNode };
				this.surfaces.set(meta.id, { meta, store: new SurfaceStore(meta.id, root) });
				this.#changed();
				return;
			}
			case "palette": {
				const surface = this.surfaces.get(message.sf);
				if (surface) surface.meta = { ...surface.meta, palette: message.palette };
				this.#changed();
				return;
			}
			case "frame":
				this.surfaces.get(message.sf)?.store.apply(message.ops as TspOp[]);
				return;
			case "close": {
				if (message.keep) {
					const surface = this.surfaces.get(message.sf);
					if (surface) {
						surface.meta = { ...surface.meta, closed: true };
						surface.store.apply([
							["del", "dock"],
							["del", "layer"],
						]);
					}
				} else this.surfaces.delete(message.sf);
				this.#changed();
				return;
			}
			case "blob":
				this.blobs.set(message.id, message.url);
				this.#changed();
				return;
			case "exit":
				this.exited = true;
				this.#changed();
				return;
			case "status":
				if (this.info) this.info = { ...this.info, title: message.title, busy: message.busy };
				this.#changed();
				return;
			case "notify":
				notify(message.title, message.body);
				return;
		}
	}

	#send(message: unknown): void {
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
	}

	keys(data: string): void {
		this.#send({ t: "keys", data });
	}

	event(ev: Record<string, unknown>): void {
		this.#send({ t: "ev", ev });
	}

	/** Open a `file://` link with the machine's default app (the server runs `open`). */
	openHref(href: string): void {
		void fetch("/api/open", {
			method: "POST",
			headers: { "x-omp-gui-token": this.#token, "content-type": "application/json" },
			body: JSON.stringify({ href }),
		});
	}

	resize(cols: number, rows: number): void {
		this.#send({ t: "resize", cols, rows });
	}

	close(): void {
		this.exited = true;
		this.#ws?.close();
	}
}
