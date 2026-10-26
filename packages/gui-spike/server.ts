/**
 * omp GUI spike: a local web app that hosts omp sessions as a Tern Surface
 * Protocol (TSP) terminal.
 *
 * The server is the "terminal": it runs each omp in a PTY, answers the TSP
 * `hello` and the few ANSI queries omp sends at startup, acknowledges frames,
 * keeps every surface's document (the reference applier from pi-tui), and
 * fans documents and ops out to browser views over a WebSocket. Views send
 * keys (raw pty bytes) and TSP events back. Sessions outlive their views, so
 * a reload or a second window re-attaches to the same live session.
 *
 * Security: omp runs shell commands, so the server binds 127.0.0.1 only and
 * every request needs the per-run token, and WebSockets must come from the
 * page's own origin (any web page can otherwise reach ws://127.0.0.1).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listPeers } from "@oh-my-pi/pi-coding-agent/peers/registry";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import type { TspFrame, TspNode } from "@oh-my-pi/pi-wire";
import index from "./index.html";
import { SUPPORTED_KINDS } from "./src/kinds";

const PORT = Number(process.env.OMP_GUI_PORT ?? 4317);
const OMP_BIN = process.env.OMP_GUI_OMP ?? path.join(os.homedir(), ".local/bin/omp");
const SESSION_DIR = process.env.OMP_GUI_SESSION_DIR ?? path.join(os.homedir(), ".omp/agent/sessions-omp-gui");
const TOKEN = process.env.OMP_GUI_TOKEN ?? crypto.randomUUID().replaceAll("-", "");
const ESC = "\x1b";
const ORIGIN = `http://127.0.0.1:${PORT}`;

type ServerMessage =
	| { t: "init"; session: SessionInfo; surfaces: SurfaceState[]; blobs: Record<string, string> }
	| { t: "open"; surface: SurfaceState }
	| { t: "frame"; sf: string; ops: TspFrame["ops"] }
	| { t: "palette"; sf: string; palette: unknown }
	| { t: "close"; sf: string; keep: boolean }
	| { t: "blob"; id: string; url: string }
	| { t: "exit"; code: number | null }
	| { t: "status"; title?: string; busy: boolean }
	| { t: "notify"; title: string; body: string };

type ClientMessage =
	| { t: "keys"; data: string }
	| { t: "ev"; ev: Record<string, unknown> }
	| { t: "resize"; cols: number; rows: number };

interface SurfaceState {
	id: string;
	mode: "inline" | "screen";
	title?: string;
	role?: string;
	palette?: unknown;
	root: TspNode;
	closed?: boolean;
}

interface SessionInfo {
	id: string;
	cwd: string;
	args: string[];
	startedAt: number;
	exited: boolean;
	/** The terminal title omp sets (OSC 0/2): the session's name. */
	title?: string;
	/** A working row is on screen (role `omp.working`). */
	busy: boolean;
}

/** Ids of every node in `node` whose role is `role`. */
function idsWithRole(node: TspNode, role: string, out: string[] = []): string[] {
	if ((node.p as { role?: string } | undefined)?.role === role) out.push(node.id);
	for (const child of node.c ?? []) idsWithRole(child, role, out);
	return out;
}

class PtySession {
	readonly info: SessionInfo;
	readonly #clients = new Set<Bun.ServerWebSocket<{ id: string }>>();
	readonly #surfaces = new Map<string, { meta: Omit<SurfaceState, "root">; doc: TspDocument }>();
	readonly #blobs = new Map<string, string>();
	readonly #chunks = new Map<string, string>();
	readonly #decoder = new TextDecoder();
	#buf = "";
	#cols = 110;
	#rows = 40;
	#proc: Bun.Subprocess;
	readonly #working = new Set<string>();

	constructor(id: string, cwd: string, args: string[]) {
		this.info = { id, cwd, args, startedAt: Date.now(), exited: false, busy: false };
		this.#proc = Bun.spawn([OMP_BIN, ...args], {
			cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "omp-gui" },
			terminal: {
				cols: this.#cols,
				rows: this.#rows,
				data: (_term, bytes) => this.#onData(bytes),
			},
		});
		void this.#proc.exited.then(code => {
			this.info.exited = true;
			this.#broadcast({ t: "exit", code });
		});
	}

	attach(ws: Bun.ServerWebSocket<{ id: string }>): void {
		this.#clients.add(ws);
		const surfaces = [...this.#surfaces.values()].map(({ meta, doc }) => ({ ...meta, root: doc.snapshot() }));
		ws.send(JSON.stringify({ t: "init", session: this.info, surfaces, blobs: Object.fromEntries(this.#blobs) }));
	}

	detach(ws: Bun.ServerWebSocket<{ id: string }>): void {
		this.#clients.delete(ws);
	}

	receive(message: ClientMessage): void {
		switch (message.t) {
			case "keys":
				this.#write(message.data);
				return;
			case "ev":
				this.#write(`${ESC}_tsp;e;${JSON.stringify(message.ev)}${ESC}\\`);
				return;
			case "resize": {
				this.#cols = Math.max(40, Math.min(400, Math.round(message.cols)));
				this.#rows = Math.max(10, Math.min(200, Math.round(message.rows)));
				this.#proc.terminal?.resize(this.#cols, this.#rows);
				this.#write(
					`${ESC}_tsp;e;${JSON.stringify({ ev: "resize", cols: this.#cols, cell: { w: 8, h: 18 } })}${ESC}\\`,
				);
				return;
			}
		}
	}

	kill(): void {
		this.#proc.kill();
	}

	get pid(): number {
		return this.#proc.pid;
	}

	/** Debug: one surface's document, or one node of it. */
	doc(sf: string, id?: string): TspNode | undefined {
		const surface = this.#surfaces.get(sf);
		return id ? surface?.doc.get(id) : surface?.doc.snapshot();
	}

	#write(data: string): void {
		if (!this.info.exited) this.#proc.terminal?.write(data);
	}

	#broadcast(message: ServerMessage): void {
		const text = JSON.stringify(message);
		for (const ws of this.#clients) ws.send(text);
	}

	/** Split the pty stream into TSP messages, the ANSI queries we answer, and plain output (dropped). */
	#onData(bytes: Uint8Array): void {
		this.#buf += this.#decoder.decode(bytes, { stream: true });
		for (;;) {
			const esc = this.#buf.indexOf(ESC);
			if (esc === -1) {
				this.#buf = "";
				return;
			}
			if (esc > 0) this.#buf = this.#buf.slice(esc);
			if (this.#buf.length < 2) return;
			const kind = this.#buf[1];
			if (kind === "_" || kind === "P" || kind === "]") {
				// APC / DCS / OSC: terminated by ST (ESC \) or, for OSC, BEL.
				const st = this.#buf.indexOf(`${ESC}\\`, 2);
				const bel = kind === "]" ? this.#buf.indexOf("\x07", 2) : -1;
				const end = bel !== -1 && (st === -1 || bel < st) ? bel : st;
				if (end === -1) return;
				const body = this.#buf.slice(2, end);
				this.#buf = this.#buf.slice(end + (end === bel ? 1 : 2));
				if (kind === "_" && body.startsWith("tsp;")) this.#onTsp(body.slice(4));
				else if (kind === "]") this.#onOsc(body);
				continue;
			}
			if (kind === "[") {
				const match = /^\x1b\[([?>=<]?)([0-9;:$]*)([ -/]*)([@-~])/.exec(this.#buf);
				if (!match) {
					if (this.#buf.length > 64) this.#buf = this.#buf.slice(1);
					return;
				}
				this.#buf = this.#buf.slice(match[0].length);
				this.#onCsi(match[1]!, match[2]!, match[3]! + match[4]!);
				continue;
			}
			// Two-byte escapes (ESC 7, ESC =, ...): skip.
			this.#buf = this.#buf.slice(2);
		}
	}

	#onOsc(body: string): void {
		const semi = body.indexOf(";");
		const code = semi === -1 ? body : body.slice(0, semi);
		const rest = semi === -1 ? "" : body.slice(semi + 1);
		if (code === "11" && rest === "?") this.#write(`${ESC}]11;rgb:1515/1818/2020${ESC}\\`);
		else if (code === "10" && rest === "?") this.#write(`${ESC}]10;rgb:e8e8/ecec/f4f4${ESC}\\`);
		else if (code === "0" || code === "2") {
			this.info.title = rest;
			this.#status();
		} else if (code === "9" && rest && !/^\d+;/.test(rest))
			this.#broadcast({ t: "notify", title: this.info.title ?? "omp", body: rest });
		else if (code === "777" && rest.startsWith("notify;")) {
			const [, title = "omp", text = ""] = rest.split(";");
			this.#broadcast({ t: "notify", title, body: text });
		} else if (code === "99") {
			const payload = rest.slice(rest.indexOf(";") + 1);
			if (payload) this.#broadcast({ t: "notify", title: this.info.title ?? "omp", body: payload });
		}
	}

	#status(): void {
		this.#broadcast({ t: "status", title: this.info.title, busy: this.info.busy });
	}

	/** Track `omp.working` rows through a frame's adds and deletes to know whether the session is busy. */
	#trackBusy(sf: string, ops: TspFrame["ops"]): void {
		const surface = this.#surfaces.get(sf);
		if (!surface) return;
		for (const op of ops)
			if (op[0] === "add") for (const id of idsWithRole(op[4], "omp.working")) this.#working.add(id);
		for (const id of this.#working) if (!surface.doc.has(id)) this.#working.delete(id);
		const busy = this.#working.size > 0;
		if (busy !== this.info.busy) {
			this.info.busy = busy;
			this.#status();
		}
	}

	#onCsi(prefix: string, params: string, final: string): void {
		if (final === "c" && prefix === "" && (params === "" || params === "0")) this.#write(`${ESC}[?62;22c`);
		else if (final === "n" && prefix === "" && params === "6") this.#write(`${ESC}[${this.#rows};1R`);
		else if (final === "q" && prefix === ">") this.#write(`${ESC}P>|omp-gui 0.1${ESC}\\`);
		else if (final === "$p" && prefix === "?") this.#write(`${ESC}[?${params};0$y`);
	}

	/** One TSP message: `<verb>[;k=v]*;<body>`, with `c=`/`m=1` chunking. */
	#onTsp(rest: string): void {
		const semi = rest.indexOf(";");
		if (semi === -1) return;
		const verb = rest.slice(0, semi);
		let tail = rest.slice(semi + 1);
		const params: Record<string, string> = {};
		for (;;) {
			const param = /^([a-z]+)=([^;]*);/.exec(tail);
			if (!param) break;
			params[param[1]!] = param[2]!;
			tail = tail.slice(param[0].length);
		}
		if (params.c !== undefined) {
			const joined = (this.#chunks.get(`${verb}:${params.c}`) ?? "") + tail;
			if (params.m === "1") {
				this.#chunks.set(`${verb}:${params.c}`, joined);
				return;
			}
			this.#chunks.delete(`${verb}:${params.c}`);
			tail = joined;
		}
		if (verb === "b") {
			this.#onBlob(params, tail);
			return;
		}
		let body: any;
		try {
			body = JSON.parse(tail);
		} catch {
			return;
		}
		switch (verb) {
			case "q":
				if (body.q === "hello") {
					const reply = {
						r: "hello",
						v: 1,
						term: "omp-gui",
						ver: "0.1",
						kinds: SUPPORTED_KINDS,
						features: [],
						apc: 65536,
						credits: 4,
						cols: this.#cols,
						cell: { w: 8, h: 18 },
						dark: true,
						reduceMotion: false,
						hour12: false,
					};
					this.#write(`${ESC}_tsp;r;${JSON.stringify(reply)}${ESC}\\`);
				} else if (body.q === "blobs") {
					const have = (body.ids as string[]).filter(id => this.#blobs.has(id));
					this.#write(`${ESC}_tsp;r;${JSON.stringify({ r: "blobs", have })}${ESC}\\`);
				}
				return;
			case "o": {
				const existing = this.#surfaces.get(body.id);
				if (existing && body.adopt) return;
				const meta = { id: body.id as string, mode: body.mode, title: body.title, role: body.role };
				const doc = new TspDocument(body.id);
				this.#surfaces.set(body.id, { meta, doc });
				this.#broadcast({ t: "open", surface: { ...meta, root: doc.snapshot() } });
				return;
			}
			case "t": {
				const surface = this.#surfaces.get(body.sf);
				if (surface) surface.meta.palette = body;
				this.#broadcast({ t: "palette", sf: body.sf, palette: body });
				return;
			}
			case "f": {
				const surface = this.#surfaces.get(body.sf);
				if (surface) {
					const errors = surface.doc.applyFrame(body);
					for (const error of errors) {
						this.#write(
							`${ESC}_tsp;e;${JSON.stringify({ ev: "error", sf: body.sf, s: error.s, op: error.op, msg: error.msg })}${ESC}\\`,
						);
					}
					this.#broadcast({ t: "frame", sf: body.sf, ops: body.ops });
					this.#trackBusy(body.sf, body.ops);
				}
				this.#write(`${ESC}_tsp;e;${JSON.stringify({ ev: "ack", sf: body.sf, s: body.s })}${ESC}\\`);
				return;
			}
			case "x": {
				const surface = this.#surfaces.get(body.id);
				if (!surface) return;
				if (body.keep) {
					surface.doc.close();
					surface.meta.closed = true;
				} else this.#surfaces.delete(body.id);
				this.#broadcast({ t: "close", sf: body.id, keep: body.keep === true });
				return;
			}
		}
	}

	#onBlob(params: Record<string, string>, base64: string): void {
		const bytes = Buffer.from(base64, "base64");
		const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const url = `data:${params.mime ?? "application/octet-stream"};base64,${base64}`;
		this.#blobs.set(id, url);
		if (params.id && params.id !== id) this.#blobs.set(params.id, url);
		this.#broadcast({ t: "blob", id: params.id ?? id, url });
	}
}

// Kept on globalThis so `bun --hot` reloads of this file keep live sessions.
const sessions: Map<string, PtySession> = ((globalThis as any).__ompGuiSessions ??= new Map());

function authorized(url: URL, req: Request): boolean {
	const token = url.searchParams.get("t") ?? req.headers.get("x-omp-gui-token");
	return token === TOKEN;
}

/** Recent sessions in the spike's session dir: header line plus the first user prompt. */
async function recentSessions(): Promise<unknown[]> {
	let names: string[] = [];
	try {
		names = (await fs.readdir(SESSION_DIR)).filter(name => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	names.sort().reverse();
	const out = [];
	for (const name of names.slice(0, 40)) {
		try {
			const text = (await Bun.file(path.join(SESSION_DIR, name)).text()).slice(0, 200_000);
			// Line 1 is a padded title slot rewritten in place, then the session header.
			const lines = text.split("\n");
			let header: { id?: string; cwd?: string; timestamp?: string } = {};
			let prompt = "";
			let title = "";
			for (const line of lines.slice(0, 400)) {
				if (!line) continue;
				const entry = JSON.parse(line);
				if (entry.type === "session") header = entry;
				if (entry.type === "title" && typeof entry.title === "string") title = entry.title;
				if (!prompt && entry.type === "message" && entry.message?.role === "user") {
					const content = entry.message.content;
					prompt =
						typeof content === "string" ? content : (content?.find?.((c: any) => c.type === "text")?.text ?? "");
				}
				if (prompt && title) break;
			}
			out.push({ id: header.id, cwd: header.cwd, timestamp: header.timestamp, title, prompt: prompt.slice(0, 160) });
		} catch {}
	}
	return out;
}

Bun.serve<{ id: string }>({
	port: PORT,
	hostname: "127.0.0.1",
	development: process.env.NODE_ENV !== "production",
	routes: {
		"/": index,
	},
	async fetch(req, server) {
		const url = new URL(req.url);
		if (!authorized(url, req)) return new Response("forbidden", { status: 403 });
		if (url.pathname === "/pty") {
			const id = url.searchParams.get("id") ?? "";
			if (!sessions.has(id)) return new Response("no such session", { status: 404 });
			if (req.headers.get("origin") !== ORIGIN) return new Response("bad origin", { status: 403 });
			return server.upgrade(req, { data: { id } }) ? undefined : new Response("upgrade failed", { status: 400 });
		}
		if (url.pathname === "/api/sessions") {
			const live = [...sessions.values()].map(session => session.info);
			return Response.json({ live, recent: await recentSessions(), sessionDir: SESSION_DIR, home: os.homedir() });
		}
		if (url.pathname === "/api/spawn" && req.method === "POST") {
			const body = (await req.json()) as { cwd?: string; resume?: string; model?: string; prompt?: string };
			const cwd = body.cwd?.replace(/^~(?=$|\/)/, os.homedir()) || os.homedir();
			const stat = await fs.stat(cwd).catch(() => null);
			if (!stat?.isDirectory()) return Response.json({ error: `not a directory: ${cwd}` }, { status: 400 });
			await fs.mkdir(SESSION_DIR, { recursive: true });
			const args = ["--session-dir", SESSION_DIR];
			if (body.resume) args.push("--resume", body.resume);
			if (body.model) args.push("--model", body.model);
			// The first message goes in as omp's positional prompt, so the session starts working on it.
			if (body.prompt?.trim() && !body.resume) args.push("--", body.prompt.trim());
			const id = crypto.randomUUID().slice(0, 8);
			sessions.set(id, new PtySession(id, cwd, args));
			return Response.json({ id });
		}
		if (url.pathname === "/api/peers") {
			// Every omp session on this machine that offers cross-session messaging, marked when this GUI hosts it.
			const hosted = new Map([...sessions.values()].map(session => [session.pid, session.info.id]));
			const peers = await listPeers().catch(() => []);
			return Response.json(
				peers.flatMap(peer =>
					peer.snapshot.sessions.map(session => ({
						...session,
						pid: peer.snapshot.pid,
						guiId: hosted.get(peer.snapshot.pid) ?? null,
					})),
				),
			);
		}
		if (url.pathname === "/api/doc") {
			const session = sessions.get(url.searchParams.get("id") ?? "");
			return Response.json(
				session?.doc(url.searchParams.get("sf") ?? "s:1", url.searchParams.get("node") ?? undefined) ?? null,
			);
		}
		if (url.pathname === "/api/open" && req.method === "POST") {
			// Open a file the transcript links to (file:// hrefs) with the macOS default app.
			const { href } = (await req.json()) as { href: string };
			const file = href.startsWith("file://") ? decodeURIComponent(new URL(href).pathname) : "";
			if (!file || !(await fs.stat(file).catch(() => null)))
				return Response.json({ error: "not a local file" }, { status: 400 });
			Bun.spawn(["open", file], { stdout: "ignore", stderr: "ignore" });
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/kill" && req.method === "POST") {
			const { id } = (await req.json()) as { id: string };
			sessions.get(id)?.kill();
			sessions.delete(id);
			return Response.json({ ok: true });
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			sessions.get(ws.data.id)?.attach(ws);
		},
		message(ws, message) {
			try {
				sessions.get(ws.data.id)?.receive(JSON.parse(String(message)) as ClientMessage);
			} catch {}
		},
		close(ws) {
			sessions.get(ws.data.id)?.detach(ws);
		},
	},
});

console.log(`omp GUI spike: ${ORIGIN}/?t=${TOKEN}`);
