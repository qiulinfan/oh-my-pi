/**
 * Requests to the GUI server, and what this page knows about that server.
 *
 * `api()` turns every failure into an `ApiError` with the server's `code`
 * (forbidden, no-session, stopping, conflict, …), or `unreachable` when the
 * request never got an answer. `link` is the page's one view of the server:
 * whether it answers, the boot (`bootId`) the page belongs to, and whether omp
 * was reinstalled under it. A failed request makes it probe /api/ping, with a
 * backoff, until the server answers again; a different boot reloads the page,
 * since the sessions it showed ended with the old server and the new server
 * may serve a newer client.
 */

export const TOKEN = new URLSearchParams(location.search).get("t") ?? "";

/** A failed request: the server's message, and its `code` when it sent one. */
export class ApiError extends Error {
	readonly code: string | undefined;
	readonly status: number;

	constructor(message: string, code: string | undefined, status: number) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
	}
}

/** What an error says to the owner: the message alone, without the class name. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: body === undefined ? "GET" : "POST",
			headers: { "x-omp-gui-token": TOKEN, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		link.lost();
		throw new ApiError("The GUI server is not reachable", "unreachable", 0);
	}
	const text = await response.text().catch(() => "");
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {}
	if (!response.ok) {
		const reply = (typeof json === "object" && json !== null ? json : {}) as { error?: unknown; code?: unknown };
		const code = typeof reply.code === "string" ? reply.code : undefined;
		// A refused token or a stopping server concerns the whole page: let the link find out which.
		if (response.status === 403 || response.status === 503) link.lost();
		const message =
			typeof reply.error === "string" ? reply.error : text.trim().slice(0, 200) || `HTTP ${response.status}`;
		throw new ApiError(message, code, response.status);
	}
	if (json === undefined) throw new ApiError("The GUI server sent a reply this page cannot read", "bad-reply", 0);
	return json as T;
}

/** The server's identity, from /api/ping, /api/sessions and every session's `init`. */
export interface ServerIdentity {
	bootId: string;
	version: string;
	/** omp's executable changed since the server started: new sessions would run a different build. */
	replaced: boolean;
}

export interface Ping extends ServerIdentity {
	pid: number;
	stopping: boolean;
}

/** `up`: answering. `down`: no answer. `stopping`: answering 503 while it ends its sessions. `rejected`: 403 to this page's token. */
export type LinkState = "up" | "down" | "stopping" | "rejected";

export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

class ServerLink {
	state: LinkState = "up";
	/** The server boot this page belongs to: the first one any reply named. */
	bootId: string | null = null;
	replaced = false;
	#listeners = new Set<() => void>();
	#waiters: (() => void)[] = [];
	#probe: Promise<Ping | null> | null = null;
	#delay = 0;
	/** Bumps to cancel the scheduled retry; `#scheduled` says whether one is pending. */
	#retry = 0;
	#scheduled = false;
	#reloading = false;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}

	#set(state: LinkState): void {
		if (this.state === state) return;
		this.state = state;
		if (state === "up") for (const resolve of this.#waiters.splice(0)) resolve();
		this.#notify();
	}

	/** Record the identity a reply carried; another boot than the page's reloads the page. */
	observe(server: Partial<ServerIdentity> | undefined): void {
		if (!server?.bootId) return;
		if (this.bootId === null) this.bootId = server.bootId;
		else if (server.bootId !== this.bootId) {
			if (!this.#reloading) {
				this.#reloading = true;
				location.reload();
			}
			return;
		}
		const replaced = server.replaced === true;
		if (replaced !== this.replaced) {
			this.replaced = replaced;
			this.#notify();
		}
	}

	/** Ping the server now (one ping at a time): the answer when it is up as itself, else null. */
	probe(): Promise<Ping | null> {
		this.#probe ??= this.#ping().finally(() => {
			this.#probe = null;
		});
		return this.#probe;
	}

	async #ping(): Promise<Ping | null> {
		let response: Response;
		try {
			response = await fetch("/api/ping", { headers: { "x-omp-gui-token": TOKEN }, cache: "no-store" });
		} catch {
			return this.#failed("down");
		}
		if (response.status === 403) {
			// Retrying cannot help: the token this page was opened with is not the server's.
			this.#cancel();
			this.#set("rejected");
			return null;
		}
		const ping = (await response.json().catch(() => null)) as Partial<Ping> | null;
		if (typeof ping?.pid !== "number") return this.#failed("down");
		this.observe(ping);
		if (ping.stopping === true || response.status === 503) return this.#failed("stopping");
		if (!response.ok) return this.#failed("down");
		this.#cancel();
		this.#delay = 0;
		this.#set("up");
		return ping as Ping;
	}

	#failed(state: "down" | "stopping"): null {
		this.#set(state);
		if (!this.#scheduled) {
			this.#scheduled = true;
			this.#delay = Math.min(this.#delay ? this.#delay * 2 : 500, 10_000);
			const retry = this.#retry;
			setTimeout(() => {
				if (retry !== this.#retry) return;
				this.#scheduled = false;
				void this.probe();
			}, this.#delay);
		}
		return null;
	}

	#cancel(): void {
		this.#retry++;
		this.#scheduled = false;
	}

	/** A request got no usable answer: find out why, and keep asking until the server is back. */
	lost(): void {
		if (this.state === "up") void this.probe();
	}

	/** The banner's "Reconnect now": ask at once, with the backoff reset. */
	retryNow(): void {
		this.#cancel();
		this.#delay = 0;
		void this.probe();
	}

	/** Resolves once the server answers as up. */
	reachable(): Promise<void> {
		if (this.state === "up") return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push(resolve);
		return promise;
	}
}

export const link = new ServerLink();
