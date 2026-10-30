/**
 * The `omp gui` server: a local web app that hosts omp sessions as a Tern
 * Surface Protocol (TSP) terminal, drawn by the `@oh-my-pi/gui` client.
 *
 * The server is the "terminal": it runs each omp in a PTY, answers the TSP
 * `hello` and the few ANSI queries omp sends at startup, acknowledges frames,
 * keeps every surface's document (the reference applier from pi-tui), and
 * fans documents and ops out to browser views over a WebSocket. Views send
 * keys (raw pty bytes) and TSP events back. Sessions outlive their views, so
 * a reload, a second browser window or the desktop app attach to the same
 * live session.
 *
 * Security: omp runs shell commands, so the server binds 127.0.0.1 only, and
 * every request passes a fence before the token check: its Host must name
 * this server (a DNS-rebinding page names its own host), a browser must not
 * mark it cross-site, and its Origin, when present, must be the server's own.
 * Then every request needs the machine token.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// A build-time import of the private workspace client, resolved through the monorepo's
// workspace links and never declared: the binary and the npm bundle carry the built page,
// and a published package cannot depend on a private one.
import index from "@oh-my-pi/gui/index.html";
import { SUPPORTED_KINDS } from "@oh-my-pi/gui/kinds";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { type FileLockHandle, isCompiledBinary, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { TspFrame, TspNode } from "@oh-my-pi/pi-wire";
import { $ } from "bun";
import { listPeers } from "../peers/registry";
import {
	isEmptySession,
	listAllSessions,
	listSessionsReadOnly,
	readSessionInfo,
	type SessionStatus,
	type SessionInfo as StoredSession,
} from "../session/session-listing";
import { loadPinnedSessionIds, setSessionPinned } from "../session/session-pins";
import { FileSessionStorage, tryAcquireSessionFileLease } from "../session/session-storage";
import { resolveCliEntryCmd, resolveExecutablePath } from "../subprocess/worker-client";
import { APPROVAL_MODES, isApprovalMode } from "../tools/approval";
import { processStartToken } from "../utils/process-identity";
import { type ExitStatus, type HostedEntry, HostedRoster, learnSessionFile } from "./hosted";
import { groupBelow, killGroup, killLeftovers, killPinned } from "./process-group";
import { openCommand, resolveLinkedPath } from "./open-link";
import { OutputTail, PtyStream, type StringKind } from "./pty-stream";
import {
	defaultModelRole,
	pinGuiProject,
	readGuiPrefs,
	readInstructions,
	readModelRoles,
	writeGuiPref,
	writeInstructions,
	writeModelRole,
} from "./settings-api";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isWorkDetail, WORK_DETAIL_INFO, WORK_DETAILS, type WorkDetail } from "@oh-my-pi/pi-tui/chat/work-detail";

/** No-project chats: each gets its own empty working directory here, and they share one session dir. */
const CHATS_DIR = path.join(os.homedir(), ".omp", "chats");
const CHAT_SESSION_DIR = path.join(getAgentDir(), "sessions-chats");
const ESC = "\x1b";
/** The OSC 1337 user variable omp reports its session file in (base64 of the absolute path). */
const SESSION_FILE_VAR = "omp_session_file";
/** The composer chip omp draws its work-detail mode in: a row whose text child is the mode's label. */
const WORK_DETAIL_CHIP_ROLE = "omp.composer.detail";

/** The work-detail mode a composer chip shows, from its label (see WORK_DETAIL_INFO); undefined for none. */
function chipWorkDetail(chip: TspNode | undefined): WorkDetail | undefined {
	const label = chip?.c?.find(child => child.k === "text")?.p as { text?: unknown } | undefined;
	return WORK_DETAILS.find(mode => WORK_DETAIL_INFO[mode].label === label?.text);
}

/**
 * The stop ladder: a signal (SIGINT when the user ends the session, SIGTERM when
 * the server stops), then this long for omp's own teardown, then a SIGKILL of
 * omp's process group (never of what omp detached from it: see process-group.ts)
 * and at most HARD_WAIT_MS more; once omp has exited, what it left in its process
 * group gets LEFTOVER_WAIT_MS before it is killed. The worst case of 9 s stays
 * under postmortem's 10 s cleanup pass, which bounds the server's own stop.
 */
const STOP_GRACE_MS = 7000;
const HARD_WAIT_MS = 1000;
const LEFTOVER_WAIT_MS = 1000;
/**
 * The signal that stops omp. SIGINT is the user's own stop, as Ctrl+C is, so the turn it cuts off is
 * not offered for `omp --restore`; SIGTERM, a stop from outside, leaves that turn to restore.
 */
const STOP_SIGNAL = { user: "SIGINT", server: "SIGTERM" } as const;
/** How long an exited omp's last output may take to arrive after its exit (the terminal's EOF). */
const EOF_WAIT_MS = 250;
/**
 * What places a process in the terminal the server runs in: a multiplexer session (the variables omp
 * classifies multiplexers by), its pane, devenv's reloading shell. A hosted omp's terminal is the GUI, so
 * it gets none of them: one that took itself to be inside tmux would not speak TSP to the GUI, or would
 * route it, its notifications and its pane options through the tmux of the shell `omp gui` ran in.
 */
const HOST_TERMINAL_ENV_KEYS = [
	...TERMINAL_MULTIPLEXER_ENV_KEYS,
	"TMUX_PANE",
	"ZELLIJ_PANE_ID",
	"ZELLIJ_SESSION_NAME",
	"DEVENV_RELOAD_FILE",
];
/** How long a resume waits for another process (often a session still tearing down) to release the session. */
const LEASE_WAIT_MS = 10_000;
const LEASE_POLL_MS = 250;

type EndedBy = "user" | "server";
type ErrorCode =
	| "forbidden"
	| "bad-origin"
	| "no-session"
	| "stopping"
	| "not-found"
	| "conflict"
	| "bad-request"
	| "internal";

interface ServerIdentity {
	bootId: string;
	version: string;
	replaced: boolean;
}

type ServerMessage =
	| {
			t: "init";
			session: SessionInfo;
			surfaces: SurfaceState[];
			blobs: Record<string, string>;
			server: ServerIdentity;
	  }
	| { t: "open"; surface: SurfaceState }
	| { t: "frame"; sf: string; ops: TspFrame["ops"] }
	| { t: "close"; sf: string; keep: boolean }
	| { t: "blob"; id: string; url: string }
	| ({ t: "exit"; endedBy?: EndedBy; restorable: boolean; lastOutput?: string } & ExitStatus)
	| { t: "status"; title?: string; busy: boolean; stopping: boolean }
	| { t: "notify"; title: string; body: string };

type ClientMessage =
	| { t: "keys"; data: string }
	| { t: "ev"; ev: Record<string, unknown> }
	| { t: "resize"; cols: number; rows: number };

interface SocketData {
	id: string;
}

type GuiSocket = Bun.ServerWebSocket<SocketData>;

interface SurfaceState {
	id: string;
	mode: "inline" | "screen";
	title?: string;
	role?: string;
	root: TspNode;
	closed?: boolean;
}

interface SessionInfo {
	id: string;
	cwd: string;
	args: string[];
	startedAt: number;
	pid: number;
	exited: boolean;
	/** The child's exit, once it has exited. Code 0 with no `endedBy`: omp ended by itself, cleanly (/exit). */
	exit?: ExitStatus;
	/** Being stopped: input is dropped until the child exits. */
	stopping: boolean;
	/** Who ended it: the user (End session) or the server stopping. Absent when omp exited on its own. */
	endedBy?: EndedBy;
	/**
	 * Once it has exited: `/api/spawn {from: id}` can bring it back, since omp wrote its session
	 * file or it has a first message to start again. False when the user ended it, or omp did cleanly.
	 */
	restorable?: boolean;
	/** The terminal title omp sets (OSC 0/2): the session's name. */
	title?: string;
	/** A working row is on screen (role `omp.working`). */
	busy: boolean;
	/** The omp session file: the resume path at first, then what omp reports. */
	sessionFile?: string;
	/** Once exited: the last lines omp printed outside the protocol (a crash's error, say), sanitized. */
	lastOutput?: string;
}

/** What a PTY session needs from the server that hosts it. */
interface SessionHost {
	readonly stopping: boolean;
	identity(): ServerIdentity;
	sessionFileChanged(session: PtySession): void;
	/** omp's composer chip shows another work-detail mode: the user switched it in the session. */
	workDetailChanged(session: PtySession, mode: WorkDetail): void;
	/** Settle the roster for a session whose omp has exited; resolves whether it holds anything to restore. */
	exited(session: PtySession): Promise<boolean>;
}

function fail(status: number, code: ErrorCode, error: string): Response {
	return Response.json({ error, code }, { status });
}

/** Ids of every node in `node` whose role is `role`. */
function idsWithRole(node: TspNode, role: string, out: string[] = []): string[] {
	if ((node.p as { role?: string } | undefined)?.role === role) out.push(node.id);
	for (const child of node.c ?? []) idsWithRole(child, role, out);
	return out;
}

/** Whether `exited` settles within `ms`. */
function exitsWithin(exited: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

const STRING_KINDS: Record<StringKind, string> = { _: "apc", P: "dcs", "]": "osc" };

/** What of omp's process group to end once omp has exited (see process-group.ts); nothing when it cannot be read. */
function leftBehind(omp: Process, session: string): Process[] {
	try {
		return groupBelow(omp);
	} catch (err) {
		logger.warn("gui: could not list omp's process group", { session, error: String(err) });
		return [];
	}
}

class PtySession {
	readonly info: SessionInfo;
	readonly #host: SessionHost;
	readonly #clients = new Set<GuiSocket>();
	readonly #surfaces = new Map<string, { meta: Omit<SurfaceState, "root">; doc: TspDocument }>();
	readonly #blobs = new Map<string, string>();
	readonly #chunks = new Map<string, string>();
	readonly #output = new OutputTail();
	readonly #stream = new PtyStream({
		string: (kind, body) => this.#onString(kind, body),
		csi: (prefix, params, final) => {
			try {
				this.#onCsi(prefix, params, final);
			} catch (err) {
				this.#dropped("csi", err);
			}
		},
		text: text => this.#output.push(text),
		dropped: (kind, reason, length) =>
			logger.warn("gui: dropped an unreadable message from omp", {
				session: this.info.id,
				kind: STRING_KINDS[kind],
				reason,
				length,
			}),
	});
	/** Settles at the terminal's EOF: every byte omp wrote has been read. */
	readonly #eof = Promise.withResolvers<void>();
	#cols = 110;
	#rows = 40;
	/** The child, once started: the server records the session before it starts omp. */
	#proc: Bun.Subprocess | undefined;
	/** Settles once the child has exited and its views have been told. */
	#ended: Promise<void> | undefined;
	#stopped: Promise<boolean> | undefined;
	readonly #working = new Set<string>();
	/** The work-detail chip in omp's composer, once drawn, with the surface it is on. */
	#detailChip: { sf: string; id: string } | undefined;
	/** The mode that chip last showed; its first is the mode omp started in, which needs no record. */
	#workDetail: WorkDetail | undefined;

	constructor(host: SessionHost, id: string, cwd: string, args: string[], resumePath?: string) {
		this.#host = host;
		this.info = {
			id,
			cwd,
			args,
			startedAt: Date.now(),
			pid: 0,
			exited: false,
			stopping: false,
			busy: false,
			sessionFile: resumePath,
		};
	}

	get started(): boolean {
		return this.#proc !== undefined;
	}

	/** Start omp. False when the session was ended before it started; throws when the spawn fails. */
	start(): boolean {
		if (this.info.exited || this.#proc) return false;
		const { id, cwd, args } = this.info;
		const inherited: Record<string, string | undefined> = { ...process.env };
		for (const key of HOST_TERMINAL_ENV_KEYS) delete inherited[key];
		const proc = Bun.spawn([...resolveCliEntryCmd(), ...args], {
			cwd,
			env: {
				...inherited,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				TERM_PROGRAM: "omp-gui",
				// Tells an agent in this session which server hosts it (never the token, port or URL).
				OMP_GUI_SERVER_PID: String(process.pid),
			},
			terminal: {
				cols: this.#cols,
				rows: this.#rows,
				data: (_term, bytes) => {
					try {
						this.#stream.write(bytes);
					} catch (err) {
						// A parser fault outside one message: its state is unknown, so start over.
						logger.warn("gui: dropped omp output after a parser fault", { session: id, error: String(err) });
						this.#stream.reset();
						this.#chunks.clear();
						this.#resyncViews();
					}
				},
				// EOF: omp's session has let go of the terminal and every byte it wrote has been read.
				// Bun keeps the PTY master open until it is closed, and PTYs are a machine-wide limit.
				exit: term => {
					term.close();
					try {
						// A message omp never finished (it died writing one) holds back what it printed after.
						this.#stream.end();
					} catch (err) {
						logger.warn("gui: could not read omp's last output", { session: id, error: String(err) });
					}
					this.#eof.resolve();
				},
			},
		});
		this.#proc = proc;
		this.info.pid = proc.pid;
		this.#ended = proc.exited.then(() => this.#onExit(proc));
		return true;
	}

	attach(ws: GuiSocket): void {
		this.#clients.add(ws);
		const surfaces = [...this.#surfaces.values()].map(({ meta, doc }) => ({ ...meta, root: doc.snapshot() }));
		const init: ServerMessage = {
			t: "init",
			session: this.info,
			surfaces,
			blobs: Object.fromEntries(this.#blobs),
			server: this.#host.identity(),
		};
		ws.send(JSON.stringify(init));
	}

	detach(ws: GuiSocket): void {
		this.#clients.delete(ws);
	}

	receive(message: ClientMessage): void {
		// Nothing a view sends reaches omp once it is being stopped or gone (its terminal is closed).
		if (this.info.exited || this.info.stopping || this.#host.stopping) return;
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
				const terminal = this.#proc?.terminal;
				if (terminal?.closed === false) terminal.resize(this.#cols, this.#rows);
				this.#write(
					`${ESC}_tsp;e;${JSON.stringify({ ev: "resize", cols: this.#cols, cell: { w: 8, h: 18 } })}${ESC}\\`,
				);
				return;
			}
		}
	}

	/**
	 * End the child: a signal to omp alone (its own teardown reaps what it
	 * started; see {@link STOP_SIGNAL}), then a SIGKILL of its process group if it
	 * is still running after the grace, and once it has exited, a kill of what it
	 * left in that group. Resolves whether the child exited. Memoized, a failed
	 * stop too: its SIGKILL is already pending, so a second ladder could add
	 * nothing. The first caller names who ended it.
	 */
	stop(endedBy: EndedBy): Promise<boolean> {
		this.#stopped ??= (async () => {
			const proc = this.#proc;
			const ended = this.#ended;
			if (!proc || !ended) {
				// Ended while its roster entry was being written: omp never starts.
				this.info.endedBy = endedBy;
				this.info.exited = true;
				return true;
			}
			if (this.info.exited) {
				await ended;
				return true;
			}
			this.info.endedBy = endedBy;
			this.info.stopping = true;
			this.#status();
			// Pinned before the signal, while the pid is still omp's (Bun has not reaped it), with its group now.
			const omp = proc.exitCode === null && proc.signalCode === null ? Process.fromPid(proc.pid) : null;
			const left = omp ? leftBehind(omp, this.info.id) : [];
			proc.kill(STOP_SIGNAL[endedBy]);
			// Raced on Bun's own handle, which settles when Bun reaps the child, not on `ended`, which settles
			// later (after the roster is settled): once the child is reaped its pid can name another process.
			let exited = await exitsWithin(proc.exited, STOP_GRACE_MS);
			if (!exited) {
				// Not reaped yet: the pinned reference still names omp, and the group it leads is still its own.
				if (omp && proc.exitCode === null && proc.signalCode === null) {
					logger.warn("gui: session outlived its stop signal; killing its process group", {
						session: this.info.id,
					});
					try {
						killGroup(omp);
					} catch (err) {
						logger.warn("gui: could not kill the session's process group", {
							session: this.info.id,
							error: String(err),
						});
					}
				}
				// omp itself whatever its group: Bun's handle signals nothing once it has reaped the child.
				proc.kill("SIGKILL");
				exited = await exitsWithin(proc.exited, HARD_WAIT_MS);
			}
			if (exited) {
				await killLeftovers(proc.pid, left, LEFTOVER_WAIT_MS).catch(err => {
					logger.warn("gui: could not end what omp left running", { session: this.info.id, error: String(err) });
				});
				// The views hear the exit before the stop settles: a server stop closes their sockets right after.
				await ended;
			}
			return exited;
		})();
		return this.#stopped;
	}

	/** Debug: one surface's document, or one node of it. */
	doc(sf: string, id?: string): TspNode | undefined {
		const surface = this.#surfaces.get(sf);
		return id ? surface?.doc.get(id) : surface?.doc.snapshot();
	}

	async #onExit(proc: Bun.Subprocess): Promise<void> {
		this.info.exited = true;
		this.info.busy = false;
		const exit: ExitStatus = { code: proc.exitCode, signal: proc.signalCode };
		this.info.exit = exit;
		// Views offer Restore from the exit message, so it says whether there is anything to restore.
		const restorable = await this.#host.exited(this).catch(err => {
			logger.warn("gui: could not settle an exited session", { session: this.info.id, error: String(err) });
			return false;
		});
		// What omp printed last may still be on its way; a process that keeps the terminal open is not waited for.
		await exitsWithin(this.#eof.promise, EOF_WAIT_MS);
		const lastOutput = this.#output.text();
		// Set together: a defined `restorable` tells readers of the live list that the exit is fully reported.
		this.info.lastOutput = lastOutput;
		this.info.restorable = restorable;
		this.#broadcast({ t: "exit", ...exit, endedBy: this.info.endedBy, restorable, lastOutput });
	}

	#write(data: string): void {
		// The terminal closes at EOF, which can come just before the exit: a closed one throws.
		const terminal = this.#proc?.terminal;
		if (!this.info.exited && terminal && !terminal.closed) terminal.write(data);
	}

	#broadcast(message: ServerMessage): void {
		const text = JSON.stringify(message);
		for (const ws of this.#clients) {
			// 0 means Bun dropped it: the view has missed a message, and only a fresh init (on reconnect) repairs that.
			if (ws.send(text) !== 0) continue;
			this.#clients.delete(ws);
			ws.terminate();
		}
	}

	/** Close every view; each reconnects and gets a fresh init from the server's documents. */
	#resyncViews(): void {
		for (const ws of this.#clients) {
			this.#clients.delete(ws);
			ws.close(1011, "resync");
		}
	}

	/** One escape string from omp: a TSP message (APC), or an OSC report; DCS strings are not answered. */
	#onString(kind: StringKind, body: string): void {
		// The message is already cut off the stream: a fault drops it alone and parsing goes on.
		try {
			if (kind === "_" && body.startsWith("tsp;")) this.#onTsp(body.slice(4));
			else if (kind === "]") this.#onOsc(body);
		} catch (err) {
			this.#dropped(kind === "]" ? "osc" : "tsp", err);
		}
	}

	#dropped(kind: string, err: unknown): void {
		logger.warn("gui: dropped a malformed message from omp", { session: this.info.id, kind, error: String(err) });
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
		} else if (code === "1337" && rest.startsWith(`SetUserVar=${SESSION_FILE_VAR}=`)) {
			// omp clears the variable (no `=value`) when it tears down; the file stays this session's.
			const file = Buffer.from(rest.slice(`SetUserVar=${SESSION_FILE_VAR}=`.length), "base64").toString("utf8");
			if (path.isAbsolute(file) && file !== this.info.sessionFile) {
				this.info.sessionFile = file;
				this.#host.sessionFileChanged(this);
			}
		}
	}

	#status(): void {
		this.#broadcast({ t: "status", title: this.info.title, busy: this.info.busy, stopping: this.info.stopping });
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

	/**
	 * Follow the work-detail chip in omp's composer: omp keeps a mode picked with the chip for this process
	 * only, so the server learns a switch here and records it, and a restore brings the session back in it.
	 */
	#trackWorkDetail(sf: string, ops: TspFrame["ops"]): void {
		const surface = this.#surfaces.get(sf);
		if (!surface) return;
		for (const op of ops)
			if (op[0] === "add") {
				const [id] = idsWithRole(op[4], WORK_DETAIL_CHIP_ROLE);
				if (id !== undefined) this.#detailChip = { sf, id };
			}
		if (this.#detailChip?.sf !== sf) return;
		const mode = chipWorkDetail(surface.doc.get(this.#detailChip.id));
		if (mode === undefined || mode === this.#workDetail) return;
		const switched = this.#workDetail !== undefined;
		this.#workDetail = mode;
		if (switched) this.#host.workDetailChanged(this, mode);
	}

	#onCsi(prefix: string, params: string, final: string): void {
		if (final === "c" && prefix === "" && (params === "" || params === "0")) this.#write(`${ESC}[?62;22c`);
		else if (final === "n" && prefix === "" && params === "6") this.#write(`${ESC}[${this.#rows};1R`);
		else if (final === "q" && prefix === ">") this.#write(`${ESC}P>|omp-gui 0.1${ESC}\\`);
		else if (final === "$p" && prefix === "?") this.#write(`${ESC}[?${params};0$y`);
	}

	#ack(sf: string, s: number): void {
		this.#write(`${ESC}_tsp;e;${JSON.stringify({ ev: "ack", sf, s })}${ESC}\\`);
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
		try {
			this.#dispatchTsp(verb, body);
		} catch (err) {
			this.#dropped(`tsp ${verb}`, err);
			// A frame, open or close that failed part-way may have left the server's document
			// different from what the views applied: they reconnect and take a fresh init.
			if (verb === "f" || verb === "o" || verb === "x") this.#resyncViews();
			// omp holds further frames until this one is acked.
			if (verb === "f" && typeof body?.sf === "string" && typeof body?.s === "number") this.#ack(body.sf, body.s);
		}
	}

	#dispatchTsp(verb: string, body: any): void {
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
			case "f": {
				const surface = this.#surfaces.get(body.sf);
				if (surface) {
					const errors = surface.doc.applyFrame(body);
					for (const error of errors) {
						this.#write(
							`${ESC}_tsp;e;${JSON.stringify({ ev: "error", sf: body.sf, s: error.s, op: error.op, msg: error.msg })}${ESC}\\`,
						);
					}
					// Views get only the ops the server's document took, so they never hold one it lacks.
					const rejected = new Set(errors.map(error => error.op));
					const ops = (body.ops as TspFrame["ops"]).filter((_, i) => !rejected.has(i));
					if (ops.length > 0) this.#broadcast({ t: "frame", sf: body.sf, ops });
					this.#trackBusy(body.sf, ops);
					this.#trackWorkDetail(body.sf, ops);
				}
				this.#ack(body.sf, body.s);
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

/**
 * The request fence (see the module comment); null when the request may go on
 * to the token check.
 */
function fenced(req: Request, port: number): Response | null {
	const host = req.headers.get("host");
	if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
		return fail(403, "bad-origin", "request does not name this GUI server");
	if (req.headers.get("sec-fetch-site") === "cross-site") return fail(403, "bad-origin", "cross-site request");
	const origin = req.headers.get("origin");
	if (origin !== null && origin !== `http://${host}`) return fail(403, "bad-origin", "request from another origin");
	return null;
}

type PageRoute = Bun.HTMLBundle | ((req: Request, server: Bun.Server<SocketData>) => Response);

/**
 * The page's routes. From source Bun bundles the page per request, and a compiled
 * binary serves the files it embeds; Bun serves both itself, outside the fence (the
 * page holds nothing secret). An ahead-of-time bundle (the npm `dist/cli.js`) lists
 * the files relative to itself, but Bun would read them relative to the working
 * directory, so serve them from beside this module, behind the fence.
 */
function pageRoutes(bundle: Bun.HTMLBundle): Record<string, PageRoute> {
	if (!bundle.files || isCompiledBinary()) return { "/": bundle };
	const routes: Record<string, PageRoute> = {};
	for (const file of bundle.files) {
		const url = file.loader === "html" ? "/" : `/${path.posix.normalize(file.path)}`;
		const source = path.resolve(import.meta.dir, file.path);
		routes[url] = (req, server) =>
			fenced(req, server.port!) ?? new Response(Bun.file(source), { headers: file.headers });
	}
	return routes;
}

const page = pageRoutes(index);

function authorized(url: URL, req: Request, token: string): boolean {
	return (url.searchParams.get("t") ?? req.headers.get("x-omp-gui-token")) === token;
}

interface SavedSession {
	id: string;
	path: string;
	cwd: string;
	title: string;
	prompt: string;
	modified: string;
	status?: SessionStatus;
	/** `omp --restore` has a turn to continue: narrower than an interrupted or pending status. */
	restorable?: boolean;
	/** Pinned in omp's session pins, which `omp --resume` shares: listed first, and never dropped from a list. */
	pinned?: boolean;
}

interface Project {
	root: string;
	name: string;
	modified: string;
	sessions: SavedSession[];
}

function saved(session: StoredSession, pins: ReadonlySet<string>): SavedSession {
	const prompt = session.firstMessage === "(no messages)" ? "" : session.firstMessage;
	return {
		id: session.id,
		path: session.path,
		cwd: session.cwd,
		title: session.title ?? "",
		prompt: prompt.replace(/\s+/g, " ").slice(0, 160),
		// Its last message, so a session rises only on new conversation, not on an exit record omp appends.
		modified: (session.lastMessageAt ?? session.modified).toISOString(),
		status: session.status,
		restorable: session.restorable,
		pinned: pins.has(session.id) || undefined,
	};
}

/** Pinned sessions first, then the newest: every pinned one stays, with the `count` newest of the rest. */
function ordered(sessions: SavedSession[], count: number): SavedSession[] {
	const newest = sessions.toSorted((a, b) => b.modified.localeCompare(a.modified));
	return [...newest.filter(session => session.pinned), ...newest.filter(session => !session.pinned).slice(0, count)];
}

function insideChats(dir: string): boolean {
	return dir === CHATS_DIR || dir.startsWith(`${CHATS_DIR}${path.sep}`);
}

/** A fresh working directory for a no-project chat. */
async function newChatDir(): Promise<string> {
	const day = new Date().toISOString().slice(0, 10);
	const dir = path.join(CHATS_DIR, `${day}-${crypto.randomUUID().slice(0, 8)}`);
	await fs.promises.mkdir(dir, { recursive: true });
	return dir;
}

const projectRoots = new Map<string, string | null>();

/** A session's project is its git checkout, or its own directory outside one; null once that directory is gone. */
async function projectRoot(cwd: string): Promise<string | null> {
	const cached = projectRoots.get(cwd);
	if (cached !== undefined) return cached;
	let root: string | null = null;
	if ((await fs.promises.stat(cwd).catch(() => null))?.isDirectory()) {
		try {
			root = vcs.gitInfo(cwd)?.repoRoot ?? cwd;
		} catch {
			root = cwd;
		}
	}
	projectRoots.set(cwd, root);
	return root;
}

/** Projects from omp's own session store (every directory omp has run in, CLI included), newest first. */
async function listProjects(pins: ReadonlySet<string>): Promise<Project[]> {
	const projects = new Map<string, Project>();
	for (const session of await listAllSessions()) {
		if (!session.cwd || insideChats(session.cwd) || isEmptySession(session)) continue;
		const root = await projectRoot(session.cwd);
		if (!root) continue;
		let project = projects.get(root);
		if (!project) {
			project = { root, name: path.basename(root) || root, modified: "", sessions: [] };
			projects.set(root, project);
		}
		project.sessions.push(saved(session, pins));
	}
	for (const project of projects.values()) {
		project.modified = project.sessions.reduce(
			(latest, item) => (item.modified > latest ? item.modified : latest),
			"",
		);
		project.sessions = ordered(project.sessions, 50);
	}
	return [...projects.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

async function listChats(pins: ReadonlySet<string>): Promise<SavedSession[]> {
	const sessions = await listSessionsReadOnly(CHAT_SESSION_DIR, new FileSessionStorage()).catch(() => []);
	return ordered(
		sessions.filter(session => !isEmptySession(session)).map(session => saved(session, pins)),
		40,
	);
}

function expandHome(dir: string): string {
	return dir.replace(/^~(?=$|\/)/, os.homedir());
}

/** The macOS folder chooser, shown by this local server; null when the owner cancels. */
async function chooseFolder(): Promise<string | null> {
	const result =
		await $`osascript -e ${"activate"} -e ${'POSIX path of (choose folder with prompt "Choose a project folder for omp")'}`
			.quiet()
			.nothrow();
	if (result.exitCode !== 0) return null;
	return result.text().trim().replace(/\/$/, "") || null;
}

interface ModelChoice {
	selector: string;
	name: string;
	provider: string;
	/** What `--thinking` can set on the model, as omp's `/effort` picker offers it; empty when it does not think. */
	thinkingSelectors: string[];
	/** The level a session on it starts at when nothing names one; null when it does not think. */
	thinkingStart: string | null;
}

interface ModelList {
	models: ModelChoice[];
	default: string | null;
}

/** The chat models omp can use (`omp models --json`), and the `default` role from omp's config. */
async function listModels(): Promise<ModelList> {
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.OMP_GUI_SERVER_PID;
	const result = await $`${resolveCliEntryCmd()} models --json`.cwd(os.homedir()).env(env).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "omp models failed");
	const { models } = result.json() as { models: ModelChoice[] };
	return {
		// omp works out both thinking fields itself (`omp models --json`), so the start page agrees with a session.
		models: models.map(({ selector, name, provider, thinkingSelectors, thinkingStart }) => ({
			selector,
			name,
			provider,
			thinkingSelectors: Array.isArray(thinkingSelectors) ? thinkingSelectors : [],
			thinkingStart: typeof thinkingStart === "string" ? thinkingStart : null,
		})),
		default: null,
	};
}

/** The file identity of the omp executable, to tell when it is replaced on disk (a reinstall renames over it). */
interface ExecutableIdentity {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

function executableIdentity(file: string): ExecutableIdentity {
	const stat = fs.statSync(file);
	return { path: file, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** A session the previous server hosted that is not live here. */
interface InterruptedEntry extends HostedEntry {
	/** Its omp still runs (the recorded pid, with the start time recorded at spawn), outliving its server. */
	orphan: boolean;
}

/** An interrupted entry as `/api/sessions` lists it. */
interface InterruptedView {
	guiId: string;
	cwd: string;
	sessionFile?: string;
	title?: string;
	prompt?: string;
	chat: boolean;
	orphan: boolean;
	/** How omp ended by itself while the previous server ran; absent when it ran until that server stopped. */
	exit?: ExitStatus;
	/** The user ended it while the previous server stopped it, and its omp may still run: it can only be ended. */
	ending?: true;
	status?: SessionStatus;
	restorable?: boolean;
}

interface SpawnBody {
	project?: string;
	resume?: { path: string; cwd: string };
	/** With `resume`: continue an interrupted turn (`--restore`) instead of only reopening it. */
	restore?: boolean;
	/**
	 * The session this spawn restores: an interrupted entry, or a session of this run that has
	 * exited. Alone, it restores that session as recorded, and the new session takes its place.
	 */
	from?: string;
	model?: string;
	/** omp's `--thinking` level: off, minimal..max or auto (adaptive); absent keeps omp's default. */
	thinking?: string;
	/** omp's `--work-detail` mode (one of {@link WORK_DETAILS}); absent keeps omp's default. */
	workDetail?: string;
	/** omp's `--approval-mode` (one of {@link APPROVAL_MODES}); absent keeps `tools.approvalMode`. */
	approvalMode?: string;
	prompt?: string;
}

/** A spawn's session: a new one, or one the GUI already runs (`existing`). */
interface Spawned {
	id: string;
	existing?: true;
}

function spawned(result: Spawned | Response): Response {
	return result instanceof Response ? result : Response.json(result);
}

/**
 * End a process this server did not start (an orphan) as End session does: SIGINT to omp alone, a SIGKILL
 * of its process group after the grace, then what it left in that group. `target` was pinned before the
 * caller checked its identity, and each signal follows a fresh read through it, so none reaches a process
 * that took its pid since.
 */
async function stopPinned(target: Process): Promise<boolean> {
	const left = leftBehind(target, `pid ${target.pid}`);
	// Read just before the signal: the pinned reference reports a process that exited, or whose pid another
	// process wears now, as exited.
	if (target.status() !== ProcessStatus.Running) return true;
	try {
		process.kill(target.pid, STOP_SIGNAL.user);
	} catch (err) {
		if ((err as { code?: string }).code === "ESRCH") return true;
		throw err;
	}
	let exited = await target.waitForExit({ timeoutMs: STOP_GRACE_MS });
	if (!exited) {
		// An omp a GUI server started leads its group (its own terminal's); a process that does not is killed alone.
		if (!killGroup(target)) killPinned(target);
		exited = await target.waitForExit({ timeoutMs: HARD_WAIT_MS });
	}
	if (exited)
		await killLeftovers(target.pid, left, LEFTOVER_WAIT_MS).catch(err => {
			logger.warn("gui: could not end what an orphaned omp left running", { pid: target.pid, error: String(err) });
		});
	return exited;
}

/** What a session file holds for a restore, and omp's listing of it when it reads as a session. */
interface SessionFileState {
	/** A conversation `omp --restore` can continue, or a file that cannot be read here and so may hold one. */
	holds: boolean;
	stored?: StoredSession;
}

/**
 * What a session file holds. Only a file omp wrote a message to holds a conversation. No file (omp names a
 * new session's file before its first write), an empty one (created, never written), one whose header a
 * crash cut short and the file `/new` writes at once (a header, no message) hold none, so a restore starts
 * the first message again. A file that cannot be read here counts as holding one: a session is never lost
 * to a failed check. The listing, the spawn and the roster all decide by this, so a Restore does what the
 * page said it would.
 */
async function sessionFileState(file: string | undefined): Promise<SessionFileState> {
	if (!file) return { holds: false };
	const stored = await readSessionInfo(file).catch(() => undefined);
	if (stored) return { holds: !isEmptySession(stored), stored };
	// Not read as a session: tell a file that reads but is none (empty, torn) from one this server cannot read.
	try {
		await Bun.file(file).slice(0, 1).bytes();
	} catch (err) {
		return { holds: !isEnoent(err) };
	}
	return { holds: false };
}

/** Whether a restore of the entry has anything to start: a session file with a conversation, or a first message. */
async function holdsRestore(entry: HostedEntry): Promise<boolean> {
	return Boolean(entry.prompt) || (await sessionFileState(entry.sessionFile)).holds;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as { code?: string }).code === "EPERM";
	}
}

/**
 * Whether an entry's omp still runs: `running`, `gone`, or `unknown` when it may run but nothing can
 * confirm that the process wearing its pid is that omp.
 */
type Liveness = "running" | "gone" | "unknown";

/**
 * Whether the entry's omp still runs. Its pid alive with the start time recorded at spawn is `running`,
 * a hung omp included: nothing is asked of the process itself. A live pid whose start time was not
 * recorded (the previous server died first) or cannot be read now is `unknown`. An entry without a pid
 * names no process to check: its server died while recording the spawn (see {@link HostedEntry.pid}).
 */
async function liveness(entry: HostedEntry): Promise<Liveness> {
	const { pid, startToken } = entry;
	if (pid === undefined || entry.exit || !pidAlive(pid)) return "gone";
	const token = startToken === undefined ? null : await processStartToken(pid);
	if (token !== null) return token === startToken ? "running" : "gone";
	return pidAlive(pid) ? "unknown" : "gone";
}

/** The hosting state of one server run: its sessions, its roster and the sessions the previous run left. */
class GuiHost implements SessionHost {
	readonly bootId = crypto.randomUUID();
	readonly sessions = new Map<string, PtySession>();
	stopping = false;
	readonly #roster: HostedRoster | undefined;
	/** Roster entries of the live sessions, by GUI id. */
	readonly #hosted = new Map<string, HostedEntry>();
	readonly #interrupted = new Map<string, InterruptedEntry>();
	/** The read of what the previous run left (see `load`); whatever reads or changes the roster waits for it. */
	#loaded: Promise<void> = Promise.resolve();
	/**
	 * Spawns that name a session in `from`, by that id: each resolves to the session it started, if any.
	 * One that started a session stays, so a view that missed the restore is shown that session.
	 */
	readonly #restoring = new Map<string, Promise<string | undefined>>();
	readonly #executable: ExecutableIdentity | undefined;
	#models: Promise<ModelList> | null = null;
	/**
	 * The Settings page's omp (`--settings-panel`): no session, no roster entry, not listed. Closing its
	 * panel ends it; the page ends it when it leaves.
	 */
	#settingsPanel: PtySession | undefined;

	constructor(rosterDir: string | undefined) {
		this.#roster = rosterDir ? new HostedRoster(rosterDir) : undefined;
		this.#executable = isCompiledBinary() ? executableIdentity(resolveExecutablePath()) : undefined;
	}

	/**
	 * Read the sessions the previous server left, in the background: every one is interrupted now, since
	 * the caller holds the lease. The server answers meanwhile, so a slow read never makes it look hung.
	 */
	load(): void {
		this.#loaded = this.#loadInterrupted().catch(err => {
			logger.warn("gui: could not read the hosted-session roster", { error: String(err) });
		});
	}

	async #loadInterrupted(): Promise<void> {
		const entries = (await this.#roster?.read()) ?? [];
		// A crash between writing a restore's entry and removing the one it restored leaves both: the restore wins.
		const restored = new Set(entries.flatMap(entry => (entry.restoredFrom ? [entry.restoredFrom] : [])));
		// Two entries of one file (the same window of a resume): the newer wins.
		const newest = new Map<string, HostedEntry>();
		for (const entry of entries) {
			if (!entry.sessionFile) continue;
			const other = newest.get(entry.sessionFile);
			if (!other || other.startedAt < entry.startedAt) newest.set(entry.sessionFile, entry);
		}
		for (const entry of entries) {
			if (restored.has(entry.guiId) || (entry.sessionFile && newest.get(entry.sessionFile) !== entry)) {
				await this.#unrecord(entry.guiId);
				continue;
			}
			// One that may still run is kept as such, never offered for a restore beside itself.
			const orphan = (await liveness(entry)) !== "gone";
			// Gone, a session the user ended is done with (its previous server died while stopping it), and one
			// that left neither a conversation nor a first message holds nothing to restore.
			if (!orphan && (entry.ending || !(await holdsRestore(entry)))) {
				await this.#unrecord(entry.guiId);
				continue;
			}
			this.#interrupted.set(entry.guiId, { ...entry, orphan });
		}
	}

	identity(): ServerIdentity {
		return { bootId: this.bootId, version: VERSION, replaced: this.#replaced() };
	}

	/** A session started now would run another omp build than this server: the executable was replaced or removed. */
	#replaced(): boolean {
		const recorded = this.#executable;
		if (!recorded) return false;
		let now: ExecutableIdentity;
		try {
			now = executableIdentity(recorded.path);
		} catch {
			// Gone (or unreadable): a session started now cannot run this server's build.
			return true;
		}
		return (
			now.dev !== recorded.dev ||
			now.ino !== recorded.ino ||
			now.size !== recorded.size ||
			now.mtimeMs !== recorded.mtimeMs
		);
	}

	sessionFileChanged(session: PtySession): void {
		const entry = this.#hosted.get(session.info.id);
		const file = session.info.sessionFile;
		if (!entry || !file) return;
		learnSessionFile(entry, file);
		this.#persist(entry);
	}

	workDetailChanged(session: PtySession, mode: WorkDetail): void {
		const entry = this.#hosted.get(session.info.id);
		if (!entry || entry.workDetail === mode) return;
		entry.workDetail = mode;
		this.#persist(entry);
	}

	async exited(session: PtySession): Promise<boolean> {
		const { id, endedBy, exit } = session.info;
		// Ended by the user: it leaves the live list, and its entry goes (/api/kill drops it too, but not when
		// omp outlived the ladder and exits only later).
		if (endedBy === "user") {
			this.sessions.delete(id);
			await this.#unrecord(id);
			return false;
		}
		const entry = this.#hosted.get(id);
		if (!entry) return false;
		if (!endedBy && exit) {
			if (exit.code === 0 && exit.signal === null) {
				// omp ended by itself, cleanly (/exit, quit): nothing was cut off, and no server offers it again.
				// It stays on the live list, exited, until it is dismissed or opened again.
				await this.#unrecord(id);
				return false;
			}
			// A crash, or a signal from elsewhere: the next server says how it ended.
			entry.exit = exit;
			await this.#persist(entry);
		}
		// A restore by `from` (see `#start`) brings back a session file omp wrote, or a first message.
		return holdsRestore(entry);
	}

	/** A session, or the Settings page's omp, by GUI id: what a view's socket attaches to. */
	session(id: string): PtySession | undefined {
		return this.sessions.get(id) ?? (this.#settingsPanel?.info.id === id ? this.#settingsPanel : undefined);
	}

	/** Start the Settings page's omp in the home directory (so no project layer applies), or name the running one. */
	#openSettingsPanel(): Response {
		const running = this.#settingsPanel;
		if (running && !running.info.exited && !running.info.stopping) return Response.json({ id: running.info.id });
		if (this.stopping) return fail(503, "stopping", "the GUI server is stopping");
		const gui = this;
		const host: SessionHost = {
			get stopping() {
				return gui.stopping;
			},
			identity: () => this.identity(),
			sessionFileChanged: () => {},
			workDetailChanged: () => {},
			exited: async session => {
				if (this.#settingsPanel === session) this.#settingsPanel = undefined;
				return false;
			},
		};
		const panel = new PtySession(host, crypto.randomUUID().slice(0, 8), os.homedir(), [
			"--no-session",
			"--settings-panel",
		]);
		try {
			panel.start();
		} catch (err) {
			return fail(500, "internal", `could not start omp: ${err}`);
		}
		this.#settingsPanel = panel;
		return Response.json({ id: panel.info.id });
	}

	/** Stop every session, then wait for the roster to settle. Their roster entries stay for the next server. */
	async stop(): Promise<void> {
		this.stopping = true;
		void this.#settingsPanel?.stop("server");
		const sessions = [...this.sessions.values()];
		await Promise.allSettled(sessions.map(session => session.stop("server")));
		// One stopped while its entry was being written never started: there is nothing to offer the next server.
		for (const session of sessions) if (!session.started) void this.#unrecord(session.info.id);
		await this.#roster?.flush();
	}

	async fetch(req: Request, server: Bun.Server<SocketData>, token: string): Promise<Response | undefined> {
		const fence = fenced(req, server.port!);
		if (fence) return fence;
		const url = new URL(req.url);
		if (!authorized(url, req, token)) return fail(403, "forbidden", "missing or wrong GUI token");
		const post = req.method === "POST";
		switch (url.pathname) {
			case "/pty": {
				const id = url.searchParams.get("id") ?? "";
				if (!this.session(id)) return fail(404, "no-session", `no session ${id}`);
				return server.upgrade(req, { data: { id } }) ? undefined : fail(400, "bad-request", "upgrade failed");
			}
			case "/api/ping":
				return Response.json(
					{ pid: process.pid, ...this.identity(), stopping: this.stopping },
					{ status: this.stopping ? 503 : 200 },
				);
			case "/api/live":
				return Response.json(
					[...this.sessions.values()].map(({ info }) => ({
						id: info.id,
						busy: info.busy,
						stopping: info.stopping,
						exited: info.exited,
					})),
				);
			case "/api/sessions": {
				await this.#loaded;
				const live = [...this.sessions.values()].map(session => session.info);
				const pins = await loadPinnedSessionIds();
				const [projects, chats, interrupted] = await Promise.all([
					listProjects(pins),
					listChats(pins),
					this.#listInterrupted(),
				]);
				return Response.json({
					live,
					projects,
					chats,
					interrupted,
					chatsDir: CHATS_DIR,
					home: os.homedir(),
					server: this.identity(),
				});
			}
			case "/api/models":
				// Listing takes about two seconds, so it is fetched once per server run; ?refresh=1 asks again.
				if (!this.#models || url.searchParams.has("refresh")) this.#models = listModels();
				try {
					// The default role is read each time: the Settings page changes it.
					return Response.json({ ...(await this.#models), default: await defaultModelRole() });
				} catch (err) {
					this.#models = null;
					return fail(500, "internal", String(err));
				}
			case "/api/peers":
				return this.#peers();
			case "/api/instructions":
				if (!post) return Response.json(await readInstructions());
				break;
			case "/api/model-roles":
				if (!post) return Response.json(await readModelRoles());
				break;
			case "/api/prefs":
				if (!post) return Response.json(await readGuiPrefs());
				break;
			case "/api/project-root": {
				// The project a folder belongs to, as the session lists group them: its checkout, else itself.
				const dir = expandHome(url.searchParams.get("dir") ?? "");
				if (!path.isAbsolute(dir)) return fail(400, "bad-request", "expected an absolute folder");
				return Response.json({ root: (await projectRoot(dir)) ?? dir });
			}
			case "/api/doc": {
				const session = this.session(url.searchParams.get("id") ?? "");
				return Response.json(
					session?.doc(url.searchParams.get("sf") ?? "s:1", url.searchParams.get("node") ?? undefined) ?? null,
				);
			}
		}
		if (post) {
			switch (url.pathname) {
				case "/api/choose-folder":
					// The chooser waits on the owner for as long as they take: no idle timeout.
					server.timeout(req, 0);
					return Response.json({ path: await chooseFolder() });
				case "/api/spawn":
					// A resume may wait for another process to release the session.
					server.timeout(req, 0);
					return this.#spawn(req);
				case "/api/kill":
					server.timeout(req, 0);
					return this.#kill(req);
				case "/api/open":
					return this.#open(req);
				case "/api/interrupted/dismiss":
					return this.#dismiss(req);
				case "/api/interrupted/end":
					server.timeout(req, 0);
					return this.#endOrphan(req);
				case "/api/settings-panel":
					return this.#openSettingsPanel();
				case "/api/model-roles": {
					const body = await readBody<{ role?: unknown; value?: unknown }>(req);
					if (body instanceof Response) return body;
					const value = typeof body.value === "string" && body.value ? body.value : null;
					if (typeof body.role !== "string" || !(await writeModelRole(body.role, value)))
						return fail(400, "bad-request", "expected a chat model role");
					return Response.json({ ok: true });
				}
				case "/api/pin": {
					const body = await readBody<{ id?: unknown; pinned?: unknown }>(req);
					if (body instanceof Response) return body;
					if (typeof body.id !== "string" || !body.id || typeof body.pinned !== "boolean")
						return fail(400, "bad-request", "expected a session id and whether to pin it");
					await setSessionPinned(body.id, body.pinned);
					return Response.json({ ok: true });
				}
				case "/api/project-pin": {
					const body = await readBody<{ root?: unknown; pinned?: unknown }>(req);
					if (body instanceof Response) return body;
					if (typeof body.root !== "string" || !path.isAbsolute(body.root) || typeof body.pinned !== "boolean")
						return fail(400, "bad-request", "expected a project folder and whether to pin it");
					if (!(await pinGuiProject(body.root, body.pinned)))
						return fail(400, "bad-request", "too many pinned projects to keep");
					return Response.json({ ok: true });
				}
				case "/api/prefs": {
					const body = await readBody<{ key?: unknown; value?: unknown }>(req);
					if (body instanceof Response) return body;
					if (
						typeof body.key !== "string" ||
						typeof body.value !== "string" ||
						!(await writeGuiPref(body.key, body.value))
					)
						return fail(400, "bad-request", "expected a page preference and its value");
					return Response.json({ ok: true });
				}
				case "/api/instructions": {
					const body = await readBody<{ text?: unknown; base?: unknown }>(req);
					if (body instanceof Response) return body;
					if (typeof body.text !== "string" || typeof body.base !== "string")
						return fail(400, "bad-request", "expected text and base");
					return (await writeInstructions(body.text, body.base))
						? Response.json({ ok: true })
						: fail(409, "conflict", "AGENTS.md changed elsewhere since this page read it");
				}
				case "/api/settings-panel/close":
					server.timeout(req, 0);
					await this.#settingsPanel?.stop("user");
					return Response.json({ ok: true });
			}
		}
		return fail(404, "not-found", `not found: ${url.pathname}`);
	}

	async #spawn(req: Request): Promise<Response> {
		if (this.stopping) return fail(503, "stopping", "the GUI server is stopping");
		const body = await readBody<SpawnBody>(req);
		if (body instanceof Response) return body;
		for (const key of ["project", "from", "model", "thinking", "workDetail", "approvalMode", "prompt"] as const)
			if (body[key] !== undefined && typeof body[key] !== "string")
				return fail(400, "bad-request", `${key} must be a string`);
		if (body.thinking !== undefined && !CLI_THINKING_LEVELS.includes(body.thinking as ConfiguredThinkingLevel))
			return fail(400, "bad-request", `thinking must be one of ${CLI_THINKING_LEVELS.join(", ")}`);
		if (body.workDetail !== undefined && !isWorkDetail(body.workDetail))
			return fail(400, "bad-request", `workDetail must be one of ${WORK_DETAILS.join(", ")}`);
		if (body.approvalMode !== undefined && !isApprovalMode(body.approvalMode))
			return fail(400, "bad-request", `approvalMode must be one of ${APPROVAL_MODES.join(", ")}`);
		if (body.resume !== undefined && (typeof body.resume?.path !== "string" || typeof body.resume?.cwd !== "string"))
			return fail(400, "bad-request", "resume needs a path and a cwd");
		// A spawn changes the roster, and a restore reads what the previous run left.
		await this.#loaded;
		if (body.from === undefined) return spawned(await this.#start(body));
		// One restore of a session: a second request (another view, a double submit, a view that missed the
		// first) gets the first's session, so a first message is never sent twice. After a failed attempt, or once
		// the session it started is gone, the next request tries again.
		for (let pending = this.#restoring.get(body.from); pending; pending = this.#restoring.get(body.from)) {
			const id = await pending;
			if (id !== undefined && this.sessions.has(id)) return Response.json({ id, existing: true });
			if (this.#restoring.get(body.from) === pending) this.#restoring.delete(body.from);
		}
		const claim = Promise.withResolvers<string | undefined>();
		this.#restoring.set(body.from, claim.promise);
		let result: Spawned | Response | undefined;
		try {
			result = await this.#start(body);
		} finally {
			const id = result instanceof Response ? undefined : result?.id;
			if (id === undefined) this.#restoring.delete(body.from);
			claim.resolve(id);
		}
		return spawned(result);
	}

	async #start(body: SpawnBody): Promise<Spawned | Response> {
		const from = body.from === undefined ? undefined : await this.#recorded(body.from);
		if (from instanceof Response) return from;
		let { resume, project, prompt, model, thinking } = body;
		// A display choice, not part of the turn. A bare restore brings the session back in the mode it was
		// recorded with (the page sends its current pick on every spawn, so the request's mode applies only
		// when none was recorded); any other spawn takes the mode it names.
		const bareRestore = body.from !== undefined && !resume && !project && !prompt;
		const recordedDetail = isWorkDetail(from?.workDetail) ? from.workDetail : undefined;
		const workDetail = bareRestore ? (recordedDetail ?? body.workDetail) : (body.workDetail ?? recordedDetail);
		// The approval mode follows the same rule, so a restore never runs a session with fewer prompts than it had.
		const recordedApproval = isApprovalMode(from?.approvalMode) ? from.approvalMode : undefined;
		const approvalMode = bareRestore
			? (recordedApproval ?? body.approvalMode)
			: (body.approvalMode ?? recordedApproval);
		let restore = body.restore === true;
		let chat = false;
		if (bareRestore) {
			// Restore the session as it was recorded: its session file, or else its first message on its model.
			// omp names its file before writing it, so a session that died early may have none on disk, or one
			// with no message yet (as /new writes it): either way its first message, if any, starts it again.
			if (!from) return fail(404, "not-found", `no session ${body.from} to restore`);
			if (from.sessionFile && (await sessionFileState(from.sessionFile)).holds) {
				resume = { path: from.sessionFile, cwd: from.cwd };
				restore = body.restore !== false;
			} else if (from.prompt) {
				prompt = from.prompt;
				model ??= from.model;
				thinking ??= from.thinking;
				if (!from.chat) project = from.cwd;
			} else return fail(400, "bad-request", "this session has nothing to restore");
		}

		const args: string[] = [];
		let cwd: string;
		let resumePath: string | undefined;
		if (resume) {
			cwd = resume.cwd;
			resumePath = path.resolve(resume.path);
			args.push(restore ? "--restore" : "--resume", resumePath);
		} else if (project) {
			cwd = expandHome(project);
		} else {
			cwd = await newChatDir();
		}
		const stat = await fs.promises.stat(cwd).catch(() => null);
		if (!stat?.isDirectory()) return fail(400, "bad-request", `not a directory: ${cwd}`);
		if (insideChats(cwd)) {
			chat = true;
			await fs.promises.mkdir(CHAT_SESSION_DIR, { recursive: true });
			args.push("--session-dir", CHAT_SESSION_DIR);
		}
		// A restore continues the interrupted turn on the model and thinking level it ran with.
		if (restore) {
			model = undefined;
			thinking = undefined;
		}
		if (model) args.push("--model", model);
		if (thinking) args.push("--thinking", thinking);
		if (workDetail) args.push("--work-detail", workDetail);
		if (approvalMode) args.push("--approval-mode", approvalMode);
		// The first message goes in as omp's positional prompt, so the session starts working on it.
		const firstMessage = resume ? undefined : prompt?.trim() || undefined;
		if (firstMessage) args.push("--", firstMessage);

		if (resumePath) {
			const live = this.#hosting(resumePath);
			if (live) return { id: live.info.id, existing: true };
			const busy = await this.#waitForSessionLease(resumePath);
			if (busy) return busy;
		}
		// No await from here to `sessions.set`: a concurrent resume of the same file sees this one.
		if (this.stopping) return fail(503, "stopping", "the GUI server is stopping");
		// Exited sessions of the same file, and the exited session this restores: the new session
		// supersedes their views and their roster entries once it runs.
		const superseded = new Set<string>();
		if (resumePath) {
			const live = this.#hosting(resumePath);
			if (live) return { id: live.info.id, existing: true };
			for (const [id, session] of this.sessions)
				if (session.info.exited && session.info.sessionFile === resumePath) superseded.add(id);
		}
		if (from && this.sessions.get(from.guiId)?.info.exited) superseded.add(from.guiId);
		const id = crypto.randomUUID().slice(0, 8);
		const session = new PtySession(this, id, cwd, args, resumePath);
		this.sessions.set(id, session);

		const entry: HostedEntry = {
			guiId: id,
			cwd,
			startedAt: session.info.startedAt,
			sessionFile: resumePath,
			prompt: firstMessage,
			model: firstMessage ? model : undefined,
			thinking: firstMessage ? thinking : undefined,
			workDetail,
			approvalMode,
			chat,
			restoredFrom: from?.guiId,
		};
		this.#hosted.set(id, entry);
		// Recorded before omp starts, so a crash right after the spawn never leaves an omp nobody knows of.
		try {
			await this.#roster?.write({ ...entry });
		} catch (err) {
			this.sessions.delete(id);
			this.#hosted.delete(id);
			this.#rosterFailed(id, err);
			return fail(500, "internal", `could not record the session, so omp was not started: ${err}`);
		}
		let started: boolean;
		try {
			started = session.start();
		} catch (err) {
			this.sessions.delete(id);
			await this.#unrecord(id);
			return fail(500, "internal", `could not start omp: ${err}`);
		}
		if (!started) {
			// Ended (End session, or the server stopping) while its entry was being written.
			this.sessions.delete(id);
			await this.#unrecord(id);
			return this.stopping
				? fail(503, "stopping", "the GUI server is stopping")
				: fail(409, "conflict", "the session was ended before omp started");
		}
		// The process identity, so the next server can tell whether this omp outlived this one: the pid at
		// once, then its start time, which takes a `ps` on some systems. The pid is on disk before the `ps` starts.
		entry.pid = session.info.pid;
		await this.#persist(entry);
		// Pinned before Bun can reap omp, so it is omp's pid: the start time read after is omp's if the pin still runs.
		const pinned = Process.fromPid(entry.pid);
		const startToken = await processStartToken(entry.pid);
		if (startToken !== null && pinned?.status() === ProcessStatus.Running) entry.startToken = startToken;
		await this.#persist(entry);
		// Written before the entries it replaces are removed: a crash in between leaves both, never neither.
		for (const old of superseded) {
			this.sessions.delete(old);
			await this.#unrecord(old);
		}
		// The new entry replaces the one it restores, and any other interrupted entry of the same file.
		for (const interrupted of this.#interrupted.values())
			if (interrupted.guiId === from?.guiId || (resumePath && interrupted.sessionFile === resumePath))
				await this.#unrecord(interrupted.guiId);
		return { id };
	}

	/**
	 * The recorded session `from` names: an interrupted entry, or the roster entry of
	 * a session of this run that has exited. One whose omp still runs cannot be restored:
	 * that would start a second agent on its work.
	 */
	async #recorded(guiId: string): Promise<HostedEntry | Response | undefined> {
		const interrupted = this.#interrupted.get(guiId);
		if (interrupted) {
			// One whose omp may still run is refused as well: a pid nothing can confirm may still be that omp.
			if (interrupted.orphan && (await liveness(interrupted)) !== "gone")
				return fail(409, "conflict", "this session's omp is still running; end it first");
			interrupted.orphan = false;
			// The user ended it: there is nothing to bring back (its entry goes once it is listed again).
			if (interrupted.ending) return fail(409, "conflict", "this session was ended");
			return interrupted;
		}
		const session = this.sessions.get(guiId);
		if (!session) return undefined;
		if (!session.info.exited) return fail(409, "conflict", "this session is still running");
		return this.#hosted.get(guiId);
	}

	/**
	 * A live hosted session (not exited, not being stopped) that runs `file` now: its
	 * learned session file, which starts as the resume path and follows /new and /resume.
	 */
	#hosting(file: string): PtySession | undefined {
		for (const session of this.sessions.values()) {
			if (session.info.exited || session.info.stopping) continue;
			if (session.info.sessionFile === file) return session;
		}
		return undefined;
	}

	/**
	 * Wait until no process holds `file`'s session lease, or answer why the
	 * resume cannot go on. The previous owner may still be tearing down, so a
	 * held lease is polled for a while; the probe is released before spawning.
	 */
	async #waitForSessionLease(file: string): Promise<Response | null> {
		const deadline = Date.now() + LEASE_WAIT_MS;
		for (;;) {
			let lease: FileLockHandle | null | undefined;
			try {
				lease = tryAcquireSessionFileLease(file);
			} catch (err) {
				return fail(500, "internal", `could not check whether this session is open elsewhere: ${err}`);
			}
			if (lease !== null) {
				lease?.release();
				return null;
			}
			if (this.stopping) return fail(503, "stopping", "the GUI server is stopping");
			if (Date.now() >= deadline) return fail(409, "conflict", "This session is open in another omp process");
			await Bun.sleep(LEASE_POLL_MS);
		}
	}

	async #kill(req: Request): Promise<Response> {
		const body = await readBody<{ id: string }>(req);
		if (body instanceof Response) return body;
		const session = this.sessions.get(body.id);
		if (!session) return fail(404, "no-session", `no session ${body.id}`);
		// Recorded before omp gets a signal: a server that dies during the stop never offers the session again.
		const entry = this.#hosted.get(body.id);
		if (entry && !session.info.exited) {
			entry.ending = true;
			await this.#persist(entry);
		}
		const ok = await session.stop("user");
		if (session.info.exited) this.sessions.delete(body.id);
		// Ended: its entry goes. An omp that outlived the ladder keeps its entry, marked as ended: it stays
		// listed here, stopping, and drops its entry once it exits (see `exited`); a server restart before then
		// lists it to be ended again, never to be restored, so no restart loses the only handle on it.
		if (ok) await this.#unrecord(body.id);
		return Response.json({ ok });
	}

	async #open(req: Request): Promise<Response> {
		// Open a local file the transcript links to: a `file://` href, or a path written in Markdown (relative to the
		// session's directory, `~/…`, or absolute, with an optional `:line[:col]`).
		const body = await readBody<{ href: string; session?: string }>(req);
		if (body instanceof Response) return body;
		const href = typeof body.href === "string" ? body.href : "";
		const cwd = typeof body.session === "string" ? this.sessions.get(body.session)?.info.cwd : undefined;
		const file = await resolveLinkedPath(href, cwd);
		if (!file) return fail(400, "bad-request", "not a local file");
		Bun.spawn(openCommand(file.path, file.directory), { stdout: "ignore", stderr: "ignore" });
		return Response.json({ ok: true, path: file.path });
	}

	async #peers(): Promise<Response> {
		// Every omp session on this machine that offers cross-session messaging, marked when this GUI hosts it.
		const hosted = new Map(
			[...this.sessions.values()].filter(({ info }) => !info.exited).map(({ info }) => [info.pid, info.id]),
		);
		const peers = await listPeers().catch(() => []);
		// The Settings page's omp is no session to message.
		const panel = this.#settingsPanel?.info.pid;
		return Response.json(
			peers.flatMap(peer =>
				peer.snapshot.pid === panel
					? []
					: peer.snapshot.sessions.map(session => ({
							...session,
							pid: peer.snapshot.pid,
							guiId: hosted.get(peer.snapshot.pid) ?? null,
						})),
			),
		);
	}

	async #listInterrupted(): Promise<InterruptedView[]> {
		const out: InterruptedView[] = [];
		for (const entry of this.#interrupted.values()) {
			// The same file open live here is not offered twice.
			if (entry.sessionFile && this.#hosting(entry.sessionFile)) continue;
			// An orphan that has exited since is an ordinary interrupted session, or, when it left nothing
			// to restore (it was kept at load only because it ran), nothing to offer at all.
			if (entry.orphan && (await liveness(entry)) === "gone") {
				entry.orphan = false;
				if (entry.ending || !(await holdsRestore(entry))) {
					await this.#unrecord(entry.guiId);
					continue;
				}
			}
			const { holds, stored } = await sessionFileState(entry.sessionFile);
			out.push({
				guiId: entry.guiId,
				cwd: entry.cwd,
				// Named only when a restore continues it (as `#start` decides), so the page says what Restore does.
				sessionFile: holds ? entry.sessionFile : undefined,
				title: stored?.title,
				prompt: entry.prompt,
				chat: entry.chat,
				orphan: entry.orphan,
				exit: entry.exit,
				ending: entry.ending || undefined,
				status: stored?.status,
				restorable: stored?.restorable,
			});
		}
		return out;
	}

	/**
	 * Forget an interrupted entry, or take an exited session of this run off the live list; either way its
	 * entry goes. One whose omp may still run is forgotten only with `force`: nothing here could end it after.
	 */
	async #dismiss(req: Request): Promise<Response> {
		const body = await readBody<{ guiId: string; force?: boolean }>(req);
		if (body instanceof Response) return body;
		await this.#loaded;
		const id = body.guiId;
		const interrupted = this.#interrupted.get(id);
		if (interrupted?.orphan && body.force !== true) {
			if ((await liveness(interrupted)) !== "gone")
				return fail(
					409,
					"conflict",
					"omp is still running; dismissing leaves it running with no way to end it from here",
				);
			interrupted.orphan = false;
		}
		if (!interrupted) {
			const session = this.sessions.get(id);
			if (!session) return fail(404, "not-found", `no interrupted or exited session ${id}`);
			if (!session.info.exited) return fail(409, "conflict", "this session is still running");
			this.sessions.delete(id);
		}
		await this.#unrecord(id);
		return Response.json({ ok: true });
	}

	async #endOrphan(req: Request): Promise<Response> {
		const body = await readBody<{ guiId: string }>(req);
		if (body instanceof Response) return body;
		await this.#loaded;
		const entry = this.#interrupted.get(body.guiId);
		if (!entry) return fail(404, "not-found", `no interrupted session ${body.guiId}`);
		if (!entry.orphan) return fail(409, "conflict", "this session's omp is not running");
		// Pinned before its identity is checked, so the signals reach that process alone: pids are reused.
		const target = entry.pid === undefined ? null : Process.fromPid(entry.pid);
		const state: Liveness = target ? await liveness(entry) : "gone";
		if (target && state === "running") {
			// Recorded before the signal, as End session does: a server that dies during the stop never offers it again.
			if (!entry.ending) {
				entry.ending = true;
				await this.#rewrite(entry);
			}
			const ok = await stopPinned(target);
			// Still running: it stays listed, and End can be tried again.
			if (!ok) return Response.json({ ok });
		} else if (state === "unknown") {
			return fail(
				409,
				"conflict",
				`omp's process (pid ${entry.pid}) cannot be confirmed to be this session's, so it was not signalled`,
			);
		} else {
			// It exited by itself since it was listed: End has nothing to stop, and the session is the
			// owner's to restore or dismiss now. One with nothing to restore, or already ended, is gone for good.
			entry.orphan = false;
			if (!entry.ending && (await holdsRestore(entry)))
				return fail(409, "conflict", "this session's omp has exited by itself; it can be restored now");
		}
		await this.#unrecord(entry.guiId);
		return Response.json({ ok: true });
	}

	/** Drop a session's roster entry: neither this server nor the next offers it again. */
	async #unrecord(guiId: string): Promise<void> {
		this.#hosted.delete(guiId);
		this.#interrupted.delete(guiId);
		await this.#roster?.remove(guiId).catch(err => this.#rosterFailed(guiId, err));
	}

	/** Rewrite a live session's entry; a no-op once the entry was dropped, so a late write never brings it back. */
	#persist(entry: HostedEntry): Promise<void> {
		if (this.#hosted.get(entry.guiId) !== entry) return Promise.resolve();
		return this.#roster?.write({ ...entry }).catch(err => this.#rosterFailed(entry.guiId, err)) ?? Promise.resolve();
	}

	/** Rewrite an interrupted entry, as recorded (without what this server learned of it); a no-op once dropped. */
	#rewrite(entry: InterruptedEntry): Promise<void> {
		if (this.#interrupted.get(entry.guiId) !== entry) return Promise.resolve();
		const { orphan: _, ...recorded } = entry;
		return this.#roster?.write(recorded).catch(err => this.#rosterFailed(entry.guiId, err)) ?? Promise.resolve();
	}

	#rosterFailed(guiId: string, err: unknown): void {
		logger.warn("gui: could not update the hosted-session roster", { guiId, error: String(err) });
	}
}

/** The JSON body of a request, or a bad-request response. */
async function readBody<T extends object>(req: Request): Promise<T | Response> {
	try {
		const body: unknown = await req.json();
		if (body && typeof body === "object") return body as T;
	} catch {}
	return fail(400, "bad-request", "expected a JSON object body");
}

export interface GuiServer {
	port: number;
	token: string;
	/** This run's id; a different one after a restart tells views their sessions are gone. */
	bootId: string;
	/** The page to open: the server's origin with the token. */
	url: string;
	/** Stop every session (the stop ladder), then the listener. Memoized. */
	stop(): Promise<void>;
}

export interface GuiServerOptions {
	port: number;
	token?: string;
	/**
	 * Directory of the hosted-session roster. The sessions the previous server
	 * left there are offered for restore, so the caller must hold the GUI lease;
	 * without it (the smoke probe) nothing is remembered.
	 */
	rosterDir?: string;
}

function serve(host: GuiHost, port: number, token: string): Bun.Server<SocketData> {
	return Bun.serve<SocketData>({
		port,
		hostname: "127.0.0.1",
		// From source the page is bundled per request, so a reload shows client edits; a binary serves its embedded bundle.
		development: !isCompiledBinary(),
		routes: page,
		async fetch(req, server) {
			try {
				return await host.fetch(req, server, token);
			} catch (err) {
				logger.warn("gui: request failed", { path: new URL(req.url).pathname, error: String(err) });
				return fail(500, "internal", String(err));
			}
		},
		websocket: {
			open(ws) {
				host.session(ws.data.id)?.attach(ws);
			},
			message(ws, message) {
				try {
					host.session(ws.data.id)?.receive(JSON.parse(String(message)) as ClientMessage);
				} catch {}
			},
			close(ws) {
				host.session(ws.data.id)?.detach(ws);
			},
		},
	});
}

/** Serve the GUI on 127.0.0.1, on `port` when it is free and on any free port otherwise. */
export async function startGuiServer(options: GuiServerOptions): Promise<GuiServer> {
	const token = options.token ?? crypto.randomUUID().replaceAll("-", "");
	const host = new GuiHost(options.rosterDir);
	let server: Bun.Server<SocketData>;
	try {
		server = serve(host, options.port, token);
	} catch (err) {
		if ((err as { code?: string }).code !== "EADDRINUSE" || options.port === 0) throw err;
		server = serve(host, 0, token);
	}
	// Listening already: the caller publishes the address now, while the roster is read.
	host.load();
	const port = server.port!;
	let stopped: Promise<void> | undefined;
	return {
		port,
		token,
		bootId: host.bootId,
		url: `http://127.0.0.1:${port}/?t=${token}`,
		stop() {
			stopped ??= (async () => {
				await host.stop();
				await server.stop(true);
			})();
			return stopped;
		},
	};
}
