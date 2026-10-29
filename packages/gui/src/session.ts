/**
 * One live omp session as seen by a browser view: the WebSocket to the
 * server, a store per surface, the palette, and blob URLs. Components read
 * it through React context and send keys/events back through it.
 *
 * The view is `connected` from the server's `init` (a full snapshot) until
 * the socket closes; keys and events are sent only then and never replayed.
 * When the socket closes, the view asks the server why: no answer waits for
 * the server (the page shows its own banner), another server boot reloads
 * the page, and a session the server no longer lists has `gone`; otherwise
 * it reconnects and the next `init` replaces every surface. A frame the
 * stores cannot apply closes the socket the same way, to get that snapshot.
 */
import type { TspNode, TspOp } from "@oh-my-pi/pi-wire";
import { ApiError, api, link, type ServerIdentity, sleep, TOKEN } from "./api";
import { SurfaceStore } from "./store";

export interface SurfaceMeta {
	id: string;
	mode: "inline" | "screen";
	title?: string;
	role?: string;
	palette?: { dark?: Record<string, string>; light?: Record<string, string> };
	closed?: boolean;
}

/** How omp ended: `endedBy` is "user" after End session, "server" when the GUI server stopped it, absent when omp exited on its own. */
export interface ExitInfo {
	code: number | null;
	signal: string | number | null;
	endedBy?: "user" | "server";
	/** The server can bring the session back (`/api/spawn {from: id}`): omp wrote its file, or it has a first message. */
	restorable?: boolean;
	/** The last lines omp printed outside the GUI protocol (a crash's error, say), sanitized by the server. */
	lastOutput?: string;
}

export interface SessionInfo {
	id: string;
	cwd: string;
	args: string[];
	startedAt: number;
	exited: boolean;
	title?: string;
	busy: boolean;
	pid?: number;
	/** The server is ending it (End session, or the server stopping). */
	stopping?: boolean;
	/** The child's exit, once it has exited. */
	exit?: { code: number | null; signal: string | number | null };
	endedBy?: "user" | "server";
	/** Once exited: whether the server can bring it back. */
	restorable?: boolean;
	/** Once exited: the last lines omp printed outside the GUI protocol. */
	lastOutput?: string;
	/** The session file omp reports (the resumed one until it does). */
	sessionFile?: string;
}

/** One row of /api/live. */
export interface LiveEntry {
	id: string;
	busy: boolean;
	stopping: boolean;
	exited: boolean;
}

type Listener = () => void;

/** A desktop notification when the page is hidden, else nothing (the transcript already shows it). */
function notify(title: string, body: string): void {
	if (typeof Notification === "undefined" || !document.hidden) return;
	if (Notification.permission === "granted") new Notification(title, { body });
	else if (Notification.permission !== "denied") void Notification.requestPermission();
}

/** A connection that lasted this long counts as healthy: its first reconnect is immediate. */
const HEALTHY_MS = 5000;

export class SessionConnection {
	readonly id: string;
	info: SessionInfo | null = null;
	surfaces = new Map<string, { meta: SurfaceMeta; store: SurfaceStore }>();
	blobs = new Map<string, string>();
	exited = false;
	/** Why omp ended, from the exit frame or the snapshot of an ended session. */
	exit: ExitInfo | null = null;
	/** From `init` until the socket closes: the stores hold the server's document. */
	connected = false;
	/** Whether an `init` ever arrived, so a closed view reads as reconnecting rather than connecting. */
	synced = false;
	/** The server no longer lists the session: there is nothing to reconnect to. */
	gone = false;
	/** Bumps on surface open/close/palette/exit and connection changes: the session shell re-renders. */
	version = 0;
	#ws: WebSocket | null = null;
	#listeners = new Set<Listener>();
	#disposed = false;
	#bootId: string | null = null;
	#initAt = 0;
	/** Reconnects since the last healthy connection; the first is immediate, then 0.5 s doubling to 10 s. */
	#attempt = 0;
	/** The socket was closed to get a fresh snapshot; further failures wait for it. */
	#resyncing = false;
	#size: { cols: number; rows: number } | null = null;

	constructor(id: string) {
		this.id = id;
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
		const ws = new WebSocket(
			`${location.origin.replace(/^http/, "ws")}/pty?id=${encodeURIComponent(this.id)}&t=${encodeURIComponent(TOKEN)}`,
		);
		this.#ws = ws;
		ws.onclose = () => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			if (this.connected && Date.now() - this.#initAt >= HEALTHY_MS) this.#attempt = 0;
			this.connected = false;
			this.#resyncing = false;
			this.#changed();
			void this.#recover();
		};
		ws.onmessage = event => {
			let message: any;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			this.#onMessage(message);
		};
	}

	/** After a close: find out whether the server and the session are still there, then reconnect. */
	async #recover(): Promise<void> {
		while (!this.#disposed && !this.exited) {
			const ping = await link.probe();
			if (this.#disposed) return;
			if (!ping) {
				await link.reachable();
				continue;
			}
			// Another boot: link.observe is reloading the page, and this session ended with the old server.
			const boot = this.#bootId ?? link.bootId;
			if (boot && ping.bootId !== boot) return;
			let listed = true;
			try {
				listed = (await api<LiveEntry[]>("/api/live")).some(entry => entry.id === this.id);
			} catch (err) {
				if (err instanceof ApiError && err.code === "unreachable") continue;
				// Any other answer says nothing about the session; the socket will.
			}
			if (this.#disposed) return;
			if (!listed) {
				this.gone = true;
				this.#changed();
				return;
			}
			const delay = this.#attempt === 0 ? 0 : Math.min(500 * 2 ** (this.#attempt - 1), 10_000);
			this.#attempt++;
			if (delay) await sleep(delay);
			if (!this.#disposed) this.#connect();
			return;
		}
	}

	/** The stores drifted from the server's document: close the socket, and the reconnect's `init` replaces them. */
	#resync(): void {
		if (this.#resyncing) return;
		this.#resyncing = true;
		this.#ws?.close();
	}

	#onMessage(message: any): void {
		switch (message.t) {
			case "init": {
				const server = message.server as ServerIdentity | undefined;
				this.#bootId = server?.bootId ?? this.#bootId;
				link.observe(server);
				this.info = message.session;
				this.exited = message.session.exited;
				const { exit, endedBy, restorable, lastOutput } = message.session as SessionInfo;
				if (exit) this.exit = { ...exit, endedBy, restorable, lastOutput };
				this.surfaces.clear();
				for (const surface of message.surfaces as (SurfaceMeta & { root: TspNode })[]) {
					const { root, ...meta } = surface;
					this.surfaces.set(meta.id, {
						meta: { ...meta, palette: (meta as any).palette },
						store: new SurfaceStore(meta.id, root),
					});
				}
				this.blobs = new Map(Object.entries(message.blobs ?? {}));
				this.connected = true;
				this.synced = true;
				this.#initAt = Date.now();
				if (this.#size) this.#send({ t: "resize", ...this.#size });
				this.#changed();
				return;
			}
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
			case "frame": {
				const surface = this.surfaces.get(message.sf);
				if (!surface?.store.apply(message.ops as TspOp[])) this.#resync();
				return;
			}
			case "close": {
				if (message.keep) {
					const surface = this.surfaces.get(message.sf);
					if (surface) {
						surface.meta = { ...surface.meta, closed: true };
						// Mirrors the server's own close; either region may be absent, so the result does not matter.
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
			case "exit": {
				this.exited = true;
				this.exit = {
					code: message.code ?? null,
					signal: message.signal ?? null,
					endedBy: message.endedBy,
					restorable: message.restorable === true,
					lastOutput: typeof message.lastOutput === "string" ? message.lastOutput : undefined,
				};
				if (this.info)
					this.info = {
						...this.info,
						exited: true,
						stopping: false,
						exit: this.exit,
						endedBy: this.exit.endedBy,
						restorable: this.exit.restorable,
						lastOutput: this.exit.lastOutput,
					};
				this.#changed();
				return;
			}
			case "status":
				if (this.info)
					this.info = {
						...this.info,
						title: message.title,
						busy: message.busy,
						stopping: message.stopping ?? this.info.stopping,
					};
				this.#changed();
				return;
			case "notify":
				notify(message.title, message.body);
				return;
		}
	}

	#send(message: unknown): void {
		if (this.connected && this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
	}

	keys(data: string): void {
		this.#send({ t: "keys", data });
	}

	event(ev: Record<string, unknown>): void {
		this.#send({ t: "ev", ev });
	}

	/** Open a `file://` link with the machine's default app (the server runs `open`). */
	openHref(href: string): void {
		api("/api/open", { href }).catch(() => {});
	}

	/** The view's size; sent now and again with every `init`, so omp lays out for this view after a reconnect. */
	resize(cols: number, rows: number): void {
		this.#size = { cols, rows };
		this.#send({ t: "resize", cols, rows });
	}

	/** The view is going away: close the socket and never reconnect. */
	close(): void {
		this.#disposed = true;
		this.#ws?.close();
	}
}
