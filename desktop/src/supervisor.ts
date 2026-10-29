/**
 * The parts of the desktop's server supervision that need no Electron: the
 * `omp gui` child and its handshake, the stop sequence, the restart budget,
 * the server probes behind liveness and the quit check, and crash logs.
 * main.ts wires them to the window and dialogs; bun test loads them directly.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

/** `--exit-on-stdin-close`: a server this app starts stops when the app dies, since its stdin is a pipe from here. */
export const GUI_ARGS = ["gui", "--no-open", "--json", "--exit-on-stdin-close"];
const STDERR_TAIL_CHARS = 64 * 1024;
const READY_TIMEOUT_MS = 30_000;
/** Longer than the server's own stop ladder (SIGTERM to each session, 7 s, then a kill), so a clean stop is not cut short. */
const STOP_GRACE_MS = 12_000;
const STOP_KILL_MS = 2_000;
const PING_TIMEOUT_MS = 1_500;
const LIVE_TIMEOUT_MS = 2_000;
const CRASH_LOGS_KEPT = 10;
const CRASH_LOG_NAME = /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-server\.log$/;

/** The line `omp gui --json` prints for the server it attached to or started. */
export interface GuiAddress {
	pid: number;
	port: number;
	token: string;
	url: string;
	attached: boolean;
}

/** What one `omp gui --json` stdout line says: the server's address, an `{error, pid}` failure, or nothing. */
export type Announcement = { address: GuiAddress } | { error: string; pid?: number };

export interface ExitStatus {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Set when the process could not be started at all. */
	error?: string;
}

export class GuiStartError extends Error {
	/** The pid of a published server that did not answer, when `omp gui` reported one. */
	readonly serverPid: number | undefined;
	constructor(message: string, serverPid?: number) {
		super(message);
		this.name = "GuiStartError";
		this.serverPid = serverPid;
	}
}

export function parseAnnouncement(line: string): Announcement | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const said = value as Record<string, unknown>;
	if (typeof said.error === "string") {
		return typeof said.pid === "number" ? { error: said.error, pid: said.pid } : { error: said.error };
	}
	const { pid, port, token, url } = said;
	if (typeof pid !== "number" || typeof port !== "number" || typeof token !== "string" || typeof url !== "string") {
		return null;
	}
	return { address: { pid, port, token, url, attached: said.attached === true } };
}

async function isExecutableFile(file: string): Promise<boolean> {
	try {
		await fs.access(file, fs.constants.X_OK);
		return (await fs.stat(file)).isFile();
	} catch {
		return false;
	}
}

/**
 * The omp to run: `named` (OMP_DESKTOP_OMP) alone when set, else the first
 * `omp` on `searchPath`, then `<home>/.local/bin/omp`. A named omp has no
 * fallback, so a test run whose own omp is mistyped or not executable fails
 * instead of reaching the owner's omp and its GUI server. Throws when there is
 * nothing to run. Relative paths never count: they would be checked against
 * this app's directory but run from the home directory.
 */
export async function findOmp(
	named: string | undefined,
	searchPath: string | undefined,
	home: string,
): Promise<string> {
	if (named) {
		if (!path.isAbsolute(named)) throw new Error(`OMP_DESKTOP_OMP must be an absolute path: ${named}`);
		if (!(await isExecutableFile(named))) throw new Error(`OMP_DESKTOP_OMP is not an executable file: ${named}`);
		return named;
	}
	const dirs = (searchPath ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir));
	for (const candidate of [...dirs.map(dir => path.join(dir, "omp")), path.join(home, ".local", "bin", "omp")]) {
		if (await isExecutableFile(candidate)) return candidate;
	}
	throw new Error("omp was not found on the login shell's PATH or at ~/.local/bin/omp.");
}

/** `text` with the GUI token replaced, for anything shown, logged or written to disk. */
export function redact(text: string, token: string | undefined): string {
	return token ? text.replaceAll(token, "<token>") : text;
}

export function describeExit(status: ExitStatus): string {
	if (status.error) return `could not start (${status.error})`;
	if (status.signal) return `was killed by ${status.signal}`;
	return `exited with code ${status.code}`;
}

/** The newest output of a stream, bounded, so a long-lived server's stderr cannot grow without limit. */
export class StderrTail {
	#text = "";
	#limit: number;

	constructor(limit = STDERR_TAIL_CHARS) {
		this.#limit = limit;
	}

	push(chunk: string): void {
		this.#text = (this.#text + chunk).slice(-this.#limit);
	}

	get text(): string {
		return this.#text;
	}

	/** The last `count` non-empty lines, for a dialog. */
	lastLines(count: number): string {
		return this.#text
			.split("\n")
			.filter(line => line.trim())
			.slice(-count)
			.join("\n");
	}
}

/** At most `limit` events in any sliding `windowMs`. */
export class Budget {
	#times: number[] = [];
	#limit: number;
	#windowMs: number;

	constructor(limit: number, windowMs: number) {
		this.#limit = limit;
		this.#windowMs = windowMs;
	}

	/** Spend one at `now`; false, spending nothing, when the window is already full. */
	take(now = Date.now()): boolean {
		this.#times = this.#times.filter(time => time > now - this.#windowMs);
		if (this.#times.length >= this.#limit) return false;
		this.#times.push(now);
		return true;
	}

	reset(): void {
		this.#times = [];
	}
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	const { promise: timeout, resolve } = Promise.withResolvers<false>();
	const timer = setTimeout(() => resolve(false), ms);
	try {
		return await Promise.race([promise.then(() => true), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * One `omp gui` child. Its stdin is the server's lifeline: this app never
 * writes to it, and it closes when the app dies, however it dies.
 */
export class GuiProcess {
	readonly omp: string;
	readonly child: ChildProcessWithoutNullStreams;
	readonly stderr = new StderrTail();
	/** Settles once the process has exited, or failed to start. */
	readonly exited: Promise<ExitStatus>;
	/** Set once this app stops the process on purpose, so its exit is not a crash. */
	expected = false;
	#status: ExitStatus | null = null;
	#ready: Promise<GuiAddress> | null = null;
	#stopped: Promise<boolean> | null = null;

	constructor(omp: string, env: NodeJS.ProcessEnv, options: { args?: string[]; cwd?: string } = {}) {
		this.omp = omp;
		const { promise, resolve } = Promise.withResolvers<ExitStatus>();
		this.exited = promise;
		this.child = spawn(omp, options.args ?? GUI_ARGS, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.once("exit", (code, signal) => {
			this.#status = { code, signal };
			resolve(this.#status);
		});
		this.child.once("error", err => {
			if (this.child.pid !== undefined) return;
			this.#status = { code: null, signal: null, error: err.message };
			resolve(this.#status);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
		// Writing never happens; an EPIPE on the lifeline after the child exits is not an error.
		this.child.stdin.on("error", () => {});
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get alive(): boolean {
		return this.#status === null;
	}

	/**
	 * The address the child announces. Rejects on its `{error, pid}` line, on
	 * its exit before announcing, or on the timeout, after stopping it so a slow
	 * child can never go on to run a server nobody owns.
	 */
	ready(timeoutMs = READY_TIMEOUT_MS): Promise<GuiAddress> {
		this.#ready ??= this.#handshake(timeoutMs);
		return this.#ready;
	}

	async #handshake(timeoutMs: number): Promise<GuiAddress> {
		const { promise, resolve, reject } = Promise.withResolvers<GuiAddress>();
		let timedOut = false;
		// The interface keeps reading after the handshake, so the server can never block on a full stdout pipe.
		readline.createInterface({ input: this.child.stdout }).on("line", line => {
			// A child announcing after the timeout is being stopped; its server must not become this app's.
			if (timedOut) return;
			const said = parseAnnouncement(line);
			if (!said) return;
			if ("error" in said) reject(new GuiStartError(said.error, said.pid));
			else resolve(said.address);
		});
		void this.exited.then(status => {
			if (!timedOut) reject(new GuiStartError(`omp gui ${describeExit(status)} before reporting its address.`));
		});
		const timer = setTimeout(() => {
			timedOut = true;
			void this.stop().then(() =>
				reject(new GuiStartError(`omp gui did not report its address in ${Math.round(timeoutMs / 1000)} seconds.`)),
			);
		}, timeoutMs);
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
		}
	}

	/** SIGTERM, a grace period for the server's own stop, then SIGKILL. True once the process has exited. */
	stop(graceMs = STOP_GRACE_MS, killMs = STOP_KILL_MS): Promise<boolean> {
		this.expected = true;
		this.#stopped ??= this.#stop(graceMs, killMs);
		return this.#stopped;
	}

	async #stop(graceMs: number, killMs: number): Promise<boolean> {
		if (!this.alive) return true;
		this.child.kill("SIGTERM");
		if (await settlesWithin(this.exited, graceMs)) return true;
		this.child.kill("SIGKILL");
		return settlesWithin(this.exited, killMs);
	}
}

/** Where to reach a server, and which run of it this app connected to. */
export interface GuiEndpoint {
	pid: number;
	port: number;
	token: string;
	/** Absent for a server too old to report it; then only the pid identifies the run. */
	bootId?: string;
}

export type Ping =
	| { state: "ok"; pid: number; bootId?: string; replaced: boolean }
	/** The server is ending its sessions; it answers 503 until it is gone. */
	| { state: "stopping" }
	/** No answer in time: a busy server is not a dead one. */
	| { state: "slow" }
	/** Refused, refused by another token, or answered by a different server run. */
	| { state: "gone"; why: string };

function isTimeout(err: unknown): boolean {
	const name = (err as { name?: unknown } | null)?.name;
	return name === "TimeoutError" || name === "AbortError";
}

async function getJson(
	endpoint: GuiEndpoint,
	route: string,
	timeoutMs: number,
): Promise<{ status: number; body: unknown } | "timeout" | "unreachable"> {
	try {
		const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
			headers: { "x-omp-gui-token": endpoint.token },
			signal: AbortSignal.timeout(timeoutMs),
		});
		let body: unknown = null;
		try {
			body = await response.json();
		} catch (err) {
			if (isTimeout(err)) return "timeout";
		}
		return { status: response.status, body };
	} catch (err) {
		return isTimeout(err) ? "timeout" : "unreachable";
	}
}

/** GET /api/ping, classified for liveness. With `expect`, a reply from another pid or boot is "gone". */
export async function pingGui(
	endpoint: GuiEndpoint,
	expect: { pid: number; bootId?: string } | null,
	timeoutMs = PING_TIMEOUT_MS,
): Promise<Ping> {
	const reply = await getJson(endpoint, "/api/ping", timeoutMs);
	if (reply === "timeout") return { state: "slow" };
	if (reply === "unreachable") return { state: "gone", why: "no server on its port" };
	const body = (reply.body ?? {}) as { pid?: unknown; bootId?: unknown; replaced?: unknown; stopping?: unknown };
	if (reply.status === 503 && body.stopping === true) return { state: "stopping" };
	if (reply.status !== 200) return { state: "gone", why: `answered ${reply.status}` };
	if (typeof body.pid !== "number") return { state: "gone", why: "unreadable answer" };
	const bootId = typeof body.bootId === "string" ? body.bootId : undefined;
	if (expect && (body.pid !== expect.pid || (expect.bootId !== undefined && bootId !== expect.bootId))) {
		return { state: "gone", why: "another server run answered" };
	}
	return { state: "ok", pid: body.pid, bootId, replaced: body.replaced === true };
}

export interface LiveSession {
	id: string;
	busy: boolean;
	stopping: boolean;
	exited: boolean;
}

/** GET /api/live: the server's hosted sessions from memory, or null when it could not be read. */
export async function fetchLive(endpoint: GuiEndpoint, timeoutMs = LIVE_TIMEOUT_MS): Promise<LiveSession[] | null> {
	const reply = await getJson(endpoint, "/api/live", timeoutMs);
	if (typeof reply === "string" || reply.status !== 200 || !Array.isArray(reply.body)) return null;
	const sessions: LiveSession[] = [];
	for (const item of reply.body as unknown[]) {
		if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") return null;
		const entry = item as { id: string; busy?: unknown; stopping?: unknown; exited?: unknown };
		sessions.push({
			id: entry.id,
			busy: entry.busy === true,
			stopping: entry.stopping === true,
			exited: entry.exited === true,
		});
	}
	return sessions;
}

/** What quitting would end, or "unknown" when the server could not say. */
export type Inspection = { live: number; working: number } | "unknown";

/** Sessions already stopping are ending anyway, so they do not count as ones quitting would end. */
export function countLive(sessions: LiveSession[] | null): Inspection {
	if (!sessions) return "unknown";
	const live = sessions.filter(session => !session.exited && !session.stopping);
	return { live: live.length, working: live.filter(session => session.busy).length };
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The question to ask before quitting stops this app's server, or null to quit at once. It asks whenever it cannot tell. */
export function quitQuestion(inspection: Inspection): { message: string; detail: string } | null {
	if (inspection === "unknown") {
		return {
			message: "Quit omp?",
			detail: "omp could not check its sessions; quitting stops the GUI server and every session it hosts.",
		};
	}
	if (inspection.live === 0) return null;
	return {
		message: `Quit omp and end ${plural(inspection.live, "session")} (${inspection.working} working)?`,
		detail: "This app started the GUI server, so quitting stops it and the sessions it hosts.",
	};
}

export interface CrashReport {
	time: Date;
	/** What happened: the server's exit, or why it could not start. */
	reason: string;
	omp: string;
	pid?: number;
	port?: number;
	/** Redacted wherever it appears in the log: the stderr tail, and a reason quoting the page URL. */
	token?: string;
	/** The shell the environment came from, and whether reading it failed. */
	loginShell: string;
	/** The last /api/live answer from this server, if one arrived. */
	live: { at: Date; sessions: LiveSession[] } | null;
	stderr: string;
}

export function crashLogName(time: Date): string {
	return `crash-${time.toISOString().replace(/[:.]/g, "-")}-server.log`;
}

export function renderCrashLog(report: CrashReport): string {
	const live = report.live
		? `${report.live.at.toISOString()}\n${report.live.sessions.map(session => JSON.stringify(session)).join("\n") || "(no sessions)"}`
		: "(none received)";
	const text = [
		`time: ${report.time.toISOString()}`,
		`reason: ${report.reason}`,
		`omp: ${report.omp}`,
		`server pid: ${report.pid ?? "unknown"}`,
		`port: ${report.port ?? "unknown"}`,
		`login shell: ${report.loginShell}`,
		report.pid === undefined ? "" : `omp's own log for this process: omp.*.${report.pid}.log in ~/.omp/logs`,
		"",
		"--- last /api/live ---",
		live,
		"",
		"--- stderr (newest 64 KiB) ---",
		report.stderr || "(empty)",
		"",
	].join("\n");
	return redact(text, report.token);
}

/** Remove the oldest crash logs beyond `keep`; other files in the directory are never touched. */
export async function pruneCrashLogs(dir: string, keep = CRASH_LOGS_KEPT): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	const logs = names.filter(name => CRASH_LOG_NAME.test(name)).sort();
	for (const name of logs.slice(0, Math.max(0, logs.length - keep))) {
		await fs.rm(path.join(dir, name), { force: true });
	}
}

/** Write one crash log (directory 0700, file 0600) and keep the newest ten; the path, or undefined when writing failed. */
export async function writeCrashLog(dir: string, report: CrashReport): Promise<string | undefined> {
	const file = path.join(dir, crashLogName(report.time));
	try {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.chmod(dir, 0o700);
		await fs.writeFile(file, renderCrashLog(report), { mode: 0o600, flag: "wx" });
	} catch {
		return undefined;
	}
	await pruneCrashLogs(dir);
	return file;
}
