/**
 * Contract tests for the `omp gui` server: one server per runtime directory,
 * the machine token and request fence, the stop ladder, the hosted-session
 * roster and resume dedupe. Every server runs as a `bun src/cli.ts gui`
 * subprocess with its own HOME and OMP_GUI_RUNTIME_DIR and `--port 0`, so it
 * can never reach the developer's own GUI server; its sessions are real omp
 * processes, and the throwaway HOME holds no credentials, so no model is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { readLines, TempDir, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { processStartToken } from "../src/utils/process-identity";
import { tryAcquireSessionLease } from "../src/session/session-storage";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

interface Served {
	proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
	pid: number;
	port: number;
	token: string;
	attached: boolean;
}

interface LiveInfo {
	id: string;
	pid: number;
	exited: boolean;
	sessionFile?: string;
	restorable?: boolean;
	lastOutput?: string;
}

interface Interrupted {
	guiId: string;
	cwd: string;
	sessionFile?: string;
	prompt?: string;
	orphan: boolean;
	exit?: { code: number | null; signal: string | null };
	ending?: boolean;
}

/** A view on one session, as the page opens one: every message the server sent it so far. */
interface View {
	messages: { t: string; [key: string]: unknown }[];
	close(): void;
}

function exitOf(view: View): Record<string, unknown> | undefined {
	return view.messages.find(message => message.t === "exit");
}

interface DocNode {
	id: string;
	k: string;
	p?: { text?: string; role?: string };
	c?: DocNode[];
}

function findNode(node: DocNode | null | undefined, match: (node: DocNode) => boolean): DocNode | undefined {
	if (!node) return undefined;
	if (match(node)) return node;
	for (const child of node.c ?? []) {
		const found = findNode(child, match);
		if (found) return found;
	}
	return undefined;
}

function findKind(node: DocNode | null | undefined, kind: string): DocNode | undefined {
	if (!node) return undefined;
	if (node.k === kind) return node;
	for (const child of node.c ?? []) {
		const found = findKind(child, kind);
		if (found) return found;
	}
	return undefined;
}

function findEditor(node: DocNode | null | undefined): DocNode | undefined {
	return findKind(node, "editor");
}

function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as { code?: string }).code === "ESRCH";
	}
}

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(
		() => true,
		() => false,
	);
}

async function waitFor(condition: () => Promise<boolean>, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
		await Bun.sleep(100);
	}
}

/** One isolated GUI runtime: its own HOME, runtime dir and project dir, and every process it started. */
class GuiFixture {
	readonly #dir: TempDir;
	readonly #procs: Bun.Subprocess[] = [];
	/** Sessions that may outlive their server, pinned (pid and start time) while known to be ours. */
	readonly #pinned: Process[] = [];

	constructor(dir: TempDir) {
		this.#dir = dir;
	}

	static async create(): Promise<GuiFixture> {
		const dir = await TempDir.create("@omp-gui-test-");
		await fs.mkdir(path.join(dir.path(), "home"));
		await fs.mkdir(path.join(dir.path(), "project"));
		return new GuiFixture(dir);
	}

	get home(): string {
		return path.join(this.#dir.path(), "home");
	}

	get runtimeDir(): string {
		return path.join(this.#dir.path(), "runtime");
	}

	get project(): string {
		return path.join(this.#dir.path(), "project");
	}

	/**
	 * Only what a server and its sessions need. Nothing else of the runner's environment
	 * reaches them (provider keys above all), so no session can call a model.
	 */
	env(): Record<string, string | undefined> {
		return {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			HOME: this.home,
			USERPROFILE: this.home,
			OMP_GUI_RUNTIME_DIR: this.runtimeDir,
			// The session-lease directory of this test process (session-storage exports it under bun test).
			PI_TEST_SESSION_OWNERS_DIR: process.env.PI_TEST_SESSION_OWNERS_DIR,
			NO_COLOR: "1",
		};
	}

	/** Skip omp's first-run setup screens, so its sessions open on the composer and take typed commands. */
	async skipSetupWizard(): Promise<void> {
		await Bun.write(path.join(this.home, ".omp", "agent", "config.yml"), "startup:\n  setupWizard: false\n");
	}

	/** Kill `pid`'s tree at cleanup even once no server of ours is its parent. Call while it is known to be ours. */
	pin(pid: number): void {
		const pinned = Process.fromPid(pid);
		if (pinned) this.#pinned.push(pinned);
	}

	/** `omp gui --no-open --json --port 0 [extra]`. */
	gui(
		extra: string[] = [],
		stdin: "ignore" | "pipe" = "ignore",
		env: Record<string, string> = {},
	): Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> {
		const proc = Bun.spawn([process.execPath, cliEntry, "gui", "--no-open", "--json", "--port", "0", ...extra], {
			env: { ...this.env(), ...env },
			cwd: this.home,
			stdin,
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#procs.push(proc);
		return proc;
	}

	/** A process of the test's own (`sleep`), to wear a pid a roster entry names; killed at cleanup. */
	sleeper(): Bun.Subprocess {
		const proc = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		this.#procs.push(proc);
		return proc;
	}

	/** Run `omp gui` and parse the JSON line it prints. */
	async start(
		extra: string[] = [],
		stdin: "ignore" | "pipe" = "ignore",
		env: Record<string, string> = {},
	): Promise<Served> {
		const proc = this.gui(extra, stdin, env);
		const stderr = new Response(proc.stderr).text();
		let line: string | undefined;
		for await (const bytes of readLines(proc.stdout)) {
			line = new TextDecoder().decode(bytes);
			break;
		}
		if (!line) throw new Error(`omp gui printed nothing: ${await stderr}`);
		const parsed = JSON.parse(line) as { pid: number; port: number; token: string; attached: boolean };
		return { proc, ...parsed };
	}

	async api<T>(
		served: Served,
		route: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<{ status: number; body: T }> {
		const response = await fetch(`http://127.0.0.1:${served.port}${route}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { "x-omp-gui-token": served.token, ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: (await response.json()) as T };
	}

	async spawn(served: Served, body: Record<string, unknown>): Promise<LiveInfo> {
		const { status, body: spawned } = await this.api<{ id: string; error?: string }>(served, "/api/spawn", body);
		if (status !== 200) throw new Error(`spawn failed (${status}): ${spawned.error}`);
		const info = (await this.live(served)).find(session => session.id === spawned.id);
		if (!info) throw new Error(`spawned session ${spawned.id} is not live`);
		return info;
	}

	async args(served: Served, id: string): Promise<string[] | undefined> {
		const { live } = (await this.api<{ live: { id: string; args: string[] }[] }>(served, "/api/sessions")).body;
		return live.find(session => session.id === id)?.args;
	}

	async live(served: Served): Promise<LiveInfo[]> {
		return (await this.api<{ live: LiveInfo[] }>(served, "/api/sessions")).body.live;
	}

	async interrupted(served: Served): Promise<Interrupted[]> {
		return (await this.api<{ interrupted: Interrupted[] }>(served, "/api/sessions")).body.interrupted;
	}

	async sessionFile(served: Served, id: string): Promise<string | undefined> {
		return (await this.live(served)).find(session => session.id === id)?.sessionFile;
	}

	/** Wait until a session's omp has reported a session file other than `previous` (past its startup). */
	async waitForSessionFile(served: Served, id: string, previous?: string): Promise<string> {
		// As with the editor: a source-run omp on a busy machine can take over 10 s to get there.
		await waitFor(async () => ![undefined, previous].includes(await this.sessionFile(served, id)), 30_000);
		return (await this.sessionFile(served, id))!;
	}

	/** Wait until every live session has exited and the server has settled whether it has anything to restore. */
	async waitForAllSettled(served: Served): Promise<LiveInfo[]> {
		const settled = (live: LiveInfo[]) => live.every(session => session.exited && session.restorable !== undefined);
		await waitFor(async () => settled(await this.live(served)));
		return this.live(served);
	}

	async view(served: Served, id: string): Promise<View> {
		const ws = new WebSocket(`ws://127.0.0.1:${served.port}/pty?id=${id}&t=${served.token}`);
		const messages: View["messages"] = [];
		ws.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
		const opened = Promise.withResolvers<void>();
		ws.addEventListener("open", () => opened.resolve());
		ws.addEventListener("error", () => opened.reject(new Error("the session socket did not open")));
		await opened.promise;
		return { messages, close: () => ws.close() };
	}

	/** The composer omp draws in a session's main surface (over TSP), once it has drawn one. */
	async editor(served: Served, id: string): Promise<DocNode | undefined> {
		return findEditor((await this.api<DocNode | null>(served, `/api/doc?id=${id}&sf=s:1`)).body);
	}

	/** Wait until a session's omp has drawn its composer through the GUI. */
	async waitForEditor(served: Served, id: string): Promise<void> {
		// A source-run omp can take over 10 s to draw its editor while others start beside it.
		await waitFor(async () => (await this.editor(served, id)) !== undefined, 30_000);
	}

	/** Type `text` into a session's composer and press Enter, as the page does: an edit event, then the key. */
	async typeLine(served: Served, id: string, text: string): Promise<void> {
		const editor = () => this.editor(served, id);
		await this.waitForEditor(served, id);
		const ws = new WebSocket(`ws://127.0.0.1:${served.port}/pty?id=${id}&t=${served.token}`);
		const opened = Promise.withResolvers<void>();
		ws.addEventListener("open", () => opened.resolve());
		ws.addEventListener("error", () => opened.reject(new Error("the session socket did not open")));
		await opened.promise;
		try {
			const node = (await editor())!;
			const len = node.p?.text?.length ?? 0;
			const edit = { ev: "edit", sf: "s:1", id: node.id, from: 0, to: len, text, cursor: text.length, len };
			ws.send(JSON.stringify({ t: "ev", ev: edit }));
			await waitFor(async () => (await editor())?.p?.text === text);
			ws.send(JSON.stringify({ t: "keys", data: "\r" }));
		} finally {
			ws.close();
		}
	}

	/** SIGTERM the server and wait for it to finish its stop (postmortem exits 143 after its cleanup). */
	async stop(served: Served): Promise<number> {
		served.proc.kill("SIGTERM");
		return served.proc.exited;
	}

	/**
	 * Kill what this fixture started and still runs: each server with its process tree (its sessions
	 * are its children). A pid is signalled only while Bun has not reaped it, so it is never reused.
	 */
	async cleanup(): Promise<void> {
		// Only while each still runs as itself, read through its pinned reference just before: the tree walk
		// finds children by pid, so a reference whose process has exited could reach whoever wears its pid now.
		for (const pinned of this.#pinned) {
			if (pinned.status() !== ProcessStatus.Running) continue;
			try {
				pinned.killTree();
			} catch {}
		}
		for (const proc of this.#procs) {
			if (proc.exitCode === null && proc.signalCode === null) {
				try {
					Process.fromPid(proc.pid)?.killTree();
				} catch {}
			}
			proc.kill("SIGKILL");
			await proc.exited;
		}
		await this.#dir.remove();
	}
}

let fixture: GuiFixture | undefined;

async function setup(): Promise<GuiFixture> {
	fixture = await GuiFixture.create();
	return fixture;
}

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

/**
 * A session journal for `omp --resume`: its header and one user message per entry of `prompts`. With none,
 * it is the file `/new` writes at once, which holds nothing to restore.
 */
function sessionJournal(id: string, cwd: string, prompts: string[]): string {
	const timestamp = new Date().toISOString();
	const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id, timestamp, cwd }];
	let parentId: string | null = null;
	for (const text of prompts) {
		const entryId = crypto.randomUUID().slice(0, 8);
		const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		lines.push({ type: "message", id: entryId, parentId, timestamp, message });
		parentId = entryId;
	}
	return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
}

async function writeSessionFixture(
	dir: string,
	cwd: string,
	prompts: string[] = ["say hi"],
): Promise<{ file: string; id: string }> {
	const id = crypto.randomUUID();
	const file = path.join(dir, `${id}.jsonl`);
	await Bun.write(file, sessionJournal(id, cwd, prompts));
	return { file, id };
}

describe("omp gui: one server per runtime directory", () => {
	test("a second omp gui attaches to the running server", async () => {
		const gui = await setup();
		const first = await gui.start();
		expect(first.attached).toBe(false);

		const second = await gui.start();
		expect(second).toMatchObject({ attached: true, pid: first.pid, port: first.port, token: first.token });
		expect(await second.proc.exited).toBe(0);
		// The first is still the server.
		expect((await gui.api<{ pid: number }>(first, "/api/ping")).body.pid).toBe(first.pid);
	}, 30_000);

	test("a lease holder that does not answer is reported, and no second server starts", async () => {
		const gui = await setup();
		await fs.mkdir(gui.runtimeDir, { recursive: true, mode: 0o700 });
		const serverFile = path.join(gui.runtimeDir, "server.json");
		// A port nothing listens on: bind one, then close it.
		const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
		const port = closed.port!;
		closed.stop(true);
		const recorded = { pid: 999_999, port, token: "0".repeat(32), url: `http://127.0.0.1:${port}/` };
		await Bun.write(serverFile, JSON.stringify(recorded));
		const lease = tryAcquireFileLock(serverFile);
		expect(lease).not.toBeNull();
		try {
			const started = Date.now();
			const proc = gui.gui();
			const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
			expect(code).toBe(1);
			expect(JSON.parse(stdout)).toEqual({
				error: "the GUI server (pid 999999) is not responding",
				pid: 999_999,
			});
			expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
			// Nothing replaced the holder's address.
			expect(await Bun.file(serverFile).json()).toEqual(recorded);
		} finally {
			lease?.release();
		}
	}, 30_000);

	test("a relative OMP_GUI_RUNTIME_DIR is refused, never replaced by the shared runtime directory", async () => {
		const gui = await setup();
		const proc = gui.gui([], "ignore", { OMP_GUI_RUNTIME_DIR: "relative/gui" });
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(code).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("OMP_GUI_RUNTIME_DIR");
		// Neither the shared directory of this HOME nor the relative one was created.
		expect(await exists(path.join(gui.home, ".omp", "run", "gui"))).toBe(false);
		expect(await exists(path.join(gui.home, "relative"))).toBe(false);
	}, 30_000);

	test("the stdin lifeline stops the server and its sessions", async () => {
		const gui = await setup();
		const served = await gui.start(["--exit-on-stdin-close"], "pipe");
		const session = await gui.spawn(served, { project: gui.project });
		expect(processGone(session.pid)).toBe(false);

		(served.proc.stdin as Bun.FileSink).end();
		expect(await served.proc.exited).toBe(0);
		expect(processGone(session.pid)).toBe(true);
		expect(await Bun.file(path.join(gui.runtimeDir, "server.json")).exists()).toBe(false);
		// The lease went with it.
		const lease = tryAcquireFileLock(path.join(gui.runtimeDir, "server.json"));
		expect(lease).not.toBeNull();
		lease?.release();
	}, 30_000);
});

describe("omp gui: Settings page", () => {
	test("the Settings page's omp draws omp's settings, stays off the session list, and ends when closed", async () => {
		const gui = await setup();
		const served = await gui.start();
		const open = async () => (await gui.api<{ id: string }>(served, "/api/settings-panel", {})).body.id;
		const id = await open();
		// A second open names the running one.
		expect(await open()).toBe(id);
		expect((await gui.live(served)).map(session => session.id)).not.toContain(id);
		// omp's settings draw on a screen surface of their own.
		const prefs = async () => {
			for (const sf of ["s:1", "s:2", "s:3", "s:4"]) {
				const found = findKind((await gui.api<DocNode | null>(served, `/api/doc?id=${id}&sf=${sf}`)).body, "prefs");
				if (found) return found;
			}
			return undefined;
		};
		await waitFor(async () => (await prefs()) !== undefined, 30_000);

		expect((await gui.api<{ ok: boolean }>(served, "/api/settings-panel/close", {})).body.ok).toBe(true);
		expect((await gui.api(served, `/api/doc?id=${id}&sf=s:1`)).body).toBeNull();
		expect(await open()).not.toBe(id);
	}, 60_000);
});

describe("omp gui: token and request fence", () => {
	test("the machine token survives a restart, and each run has its own boot id", async () => {
		const gui = await setup();
		const first = await gui.start();
		const firstBoot = (await gui.api<{ bootId: string }>(first, "/api/ping")).body.bootId;
		expect(first.token).toMatch(/^[0-9a-f]{32}$/);
		expect(await gui.stop(first)).toBe(143);
		expect(await Bun.file(path.join(gui.runtimeDir, "server.json")).exists()).toBe(false);

		const second = await gui.start();
		expect(second.token).toBe(first.token);
		const ping = await gui.api<{ bootId: string; pid: number }>(second, "/api/ping");
		expect(ping.body.pid).toBe(second.pid);
		expect(ping.body.bootId).not.toBe(firstBoot);
		// The token is still checked after the fence.
		const wrong = await fetch(`http://127.0.0.1:${second.port}/api/ping`, { headers: { "x-omp-gui-token": "x" } });
		expect(wrong.status).toBe(403);
		expect(await wrong.json()).toMatchObject({ code: "forbidden" });
	}, 30_000);

	test("cross-origin, cross-site and foreign-Host requests are refused before they spawn anything", async () => {
		const gui = await setup();
		const served = await gui.start();
		const attempts: Record<string, string>[] = [
			{ Origin: "http://evil.example" },
			{ "Sec-Fetch-Site": "cross-site" },
			{ Host: `evil.example:${served.port}` },
		];
		for (const headers of attempts) {
			const refused = await gui.api<{ code: string }>(served, "/api/spawn", { project: gui.project }, headers);
			expect({ headers, status: refused.status, code: refused.body.code }).toEqual({
				headers,
				status: 403,
				code: "bad-origin",
			});
		}
		// The page's own origin passes the fence.
		const own = await gui.api<{ pid: number }>(served, "/api/ping", undefined, {
			Origin: `http://127.0.0.1:${served.port}`,
		});
		expect(own.status).toBe(200);
		expect((await gui.api<unknown[]>(served, "/api/live")).body).toEqual([]);
	}, 30_000);
});

describe("omp gui: ending sessions", () => {
	test("/api/kill answers only after the session's omp has exited", async () => {
		const gui = await setup();
		const served = await gui.start();
		const session = await gui.spawn(served, { project: gui.project });

		const killed = await gui.api<{ ok: boolean }>(served, "/api/kill", { id: session.id });
		expect(killed.body).toEqual({ ok: true });
		expect(processGone(session.pid)).toBe(true);
		expect(await gui.api<unknown[]>(served, "/api/live").then(r => r.body)).toEqual([]);
	}, 30_000);

	test("End stops omp as the user does (SIGINT), a server stop with SIGTERM, and each view hears which", async () => {
		const gui = await setup();
		const served = await gui.start();
		// Past its startup, omp handles both signals with its own teardown and exits 128 + the signal. One
		// at a time: two fresh-HOME omps starting together can each take most of the wait.
		const ended = await gui.spawn(served, { project: gui.project });
		await gui.waitForSessionFile(served, ended.id);
		const stopped = await gui.spawn(served, { project: gui.project });
		await gui.waitForSessionFile(served, stopped.id);
		const endedView = await gui.view(served, ended.id);
		const stoppedView = await gui.view(served, stopped.id);

		expect((await gui.api<{ ok: boolean }>(served, "/api/kill", { id: ended.id })).body).toEqual({ ok: true });
		await waitFor(async () => exitOf(endedView) !== undefined);
		// SIGINT is the user's own stop: omp never offers the turn it cut off for --restore.
		expect(exitOf(endedView)).toMatchObject({ code: 130, signal: null, endedBy: "user", restorable: false });
		expect(await gui.stop(served)).toBe(143);
		await waitFor(async () => exitOf(stoppedView) !== undefined);
		expect(exitOf(stoppedView)).toMatchObject({ code: 143, signal: null, endedBy: "server" });
	}, 60_000);

	test("an omp that fails says why: its exit carries the last lines it printed", async () => {
		const gui = await setup();
		const served = await gui.start();
		const missing = path.join(gui.project, "missing.jsonl");
		await gui.spawn(served, { resume: { path: missing, cwd: gui.project } });
		const [info] = await gui.waitForAllSettled(served);
		expect(info).toMatchObject({ exit: { code: 1, signal: null } });
		expect(info!.lastOutput).toContain("not found");
		// The last output is text for the page: no escape sequence of omp's terminal is left in it.
		expect(info!.lastOutput).not.toContain("\x1b");
	}, 30_000);

	test("a session that ignores its stop signal is killed", async () => {
		const gui = await setup();
		const served = await gui.start();
		const session = await gui.spawn(served, { project: gui.project });
		// A stopped process leaves the signal pending: it cannot act on it, like a wedged event loop.
		process.kill(session.pid, "SIGSTOP");

		const started = Date.now();
		const killed = await gui.api<{ ok: boolean }>(served, "/api/kill", { id: session.id });
		expect(killed.body).toEqual({ ok: true });
		expect(processGone(session.pid)).toBe(true);
		expect(Date.now() - started).toBeLessThan(9500);
	}, 30_000);
});

describe("omp gui: a session's terminal", () => {
	test("a session's terminal is the GUI even when omp gui runs inside tmux: omp still draws through it", async () => {
		const gui = await setup();
		await gui.skipSetupWizard();
		// The shell omp gui was started from runs in a tmux pane (of a tmux server nothing here can reach).
		const served = await gui.start([], "ignore", { TMUX: `${path.join(gui.home, "tmux")},1,0`, TMUX_PANE: "%1" });
		const session = await gui.spawn(served, { project: gui.project });
		// An omp that took itself to be inside that tmux would not speak TSP to the GUI: no surface, no editor.
		await gui.waitForEditor(served, session.id);
	}, 60_000);
});

describe("omp gui: hosted-session roster", () => {
	test("sessions running when the server stopped are listed as interrupted; ended ones are not", async () => {
		const gui = await setup();
		const first = await gui.start();
		const { file } = await writeSessionFixture(gui.project, gui.project);
		const ended = await gui.spawn(first, { project: gui.project, prompt: "end me" });
		const running = await gui.spawn(first, { resume: { path: file, cwd: gui.project } });
		expect((await gui.api<{ ok: boolean }>(first, "/api/kill", { id: ended.id })).body.ok).toBe(true);
		expect(await gui.stop(first)).toBe(143);
		expect(processGone(running.pid)).toBe(true);

		// An entry that does not parse is set aside, not taken for an empty roster.
		const hosted = path.join(gui.runtimeDir, "hosted");
		await Bun.write(path.join(hosted, "deadbeef.json"), "{not json");

		const second = await gui.start();
		const interrupted = await gui.interrupted(second);
		expect(interrupted.map(entry => entry.guiId)).toEqual([running.id]);
		expect(interrupted[0]).toMatchObject({ cwd: gui.project, sessionFile: file, orphan: false });
		expect(new Set(await fs.readdir(hosted))).toEqual(new Set(["deadbeef.json.bad", `${running.id}.json`]));

		const dismissed = await gui.api<{ ok: boolean }>(second, "/api/interrupted/dismiss", { guiId: running.id });
		expect(dismissed.body.ok).toBe(true);
		expect(await gui.stop(second)).toBe(143);

		// Dismissal is durable.
		const third = await gui.start();
		expect(await gui.interrupted(third)).toEqual([]);
	}, 60_000);

	test("restoring a session that never wrote its file starts its first message again", async () => {
		const gui = await setup();
		const first = await gui.start();
		// With no model configured in the throwaway home, the session never writes the file it names.
		const lost = await gui.spawn(first, { project: gui.project, prompt: "say hi" });
		expect(await gui.stop(first)).toBe(143);

		const second = await gui.start();
		const [entry] = await gui.interrupted(second);
		expect(entry).toMatchObject({ guiId: lost.id, prompt: "say hi" });
		// Two views restoring it at once (Restore all in two windows) start it once: the first message is sent once.
		const [a, b] = await Promise.all([
			gui.api<{ id: string }>(second, "/api/spawn", { from: lost.id }),
			gui.api<{ id: string }>(second, "/api/spawn", { from: lost.id }),
		]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(b.body.id).toBe(a.body.id);
		const live = await gui.live(second);
		expect(live.map(session => [session.id, session.exited])).toEqual([[a.body.id, false]]);
		expect(await gui.args(second, a.body.id)).toEqual(["--", "say hi"]);
		// The restore's own entry replaced the interrupted one.
		expect(await gui.interrupted(second)).toEqual([]);
	}, 60_000);

	test("restoring a session that ended in this run starts its first message again on its model, in its place", async () => {
		const gui = await setup();
		const first = await gui.start();
		const model = "deepseek/deepseek-flash";
		const crashed = await gui.spawn(first, { project: gui.project, prompt: "say hi", model });
		const empty = await gui.spawn(first, { project: gui.project });
		// A session that still runs is not restored: that would start a second agent on its work.
		const running = await gui.api<{ code: string }>(first, "/api/spawn", { from: crashed.id });
		expect({ status: running.status, code: running.body.code }).toEqual({ status: 409, code: "conflict" });
		// Both omps die before writing the file they named (a crash): only the one with a first message has
		// anything to restore, and views hear which from the server.
		process.kill(crashed.pid, "SIGKILL");
		process.kill(empty.pid, "SIGKILL");
		const ended = await gui.waitForAllSettled(first);
		expect(Object.fromEntries(ended.map(session => [session.id, session.restorable]))).toEqual({
			[crashed.id]: true,
			[empty.id]: false,
		});
		const nothing = await gui.api<{ code: string }>(first, "/api/spawn", { from: empty.id });
		expect({ status: nothing.status, code: nothing.body.code }).toEqual({ status: 400, code: "bad-request" });

		const restored = await gui.spawn(first, { from: crashed.id });
		expect(await gui.args(first, restored.id)).toEqual(["--model", model, "--", "say hi"]);
		// A view that missed the restore and asks again is shown the restored session, not a second one.
		const again = await gui.api<{ id: string; existing?: boolean }>(first, "/api/spawn", { from: crashed.id });
		expect(again.body).toEqual({ id: restored.id, existing: true });
		expect(new Set((await gui.live(first)).map(session => session.id))).toEqual(new Set([empty.id, restored.id]));
		expect(await gui.stop(first)).toBe(143);

		// The restored session's roster entry went with it: the next server offers only the restore.
		const second = await gui.start();
		expect((await gui.interrupted(second)).map(entry => entry.guiId)).toEqual([restored.id]);
	}, 60_000);

	test("a resume supersedes an exited session of its file, so the next server offers that file once", async () => {
		const gui = await setup();
		const first = await gui.start();
		const { file } = await writeSessionFixture(gui.project, gui.project);
		const resume = { resume: { path: file, cwd: gui.project } };
		const gone = await gui.spawn(first, resume);
		// omp ended by a signal from elsewhere (as a crash) keeps its entry, as a server stop does.
		process.kill(gone.pid, "SIGTERM");
		await waitFor(async () => (await gui.live(first)).find(session => session.id === gone.id)?.exited === true);
		const resumed = await gui.spawn(first, resume);
		expect((await gui.live(first)).map(session => session.id)).toEqual([resumed.id]);
		expect(await gui.stop(first)).toBe(143);

		const second = await gui.start();
		const interrupted = await gui.interrupted(second);
		expect(interrupted.map(entry => [entry.guiId, entry.sessionFile])).toEqual([[resumed.id, file]]);
		// Restoring the entry as recorded continues its file with --restore.
		const restored = await gui.spawn(second, { from: resumed.id });
		expect(await gui.args(second, restored.id)).toEqual(["--restore", file]);
		expect(await gui.interrupted(second)).toEqual([]);
	}, 60_000);

	test("a session starts at the thinking level picked, a first-message restore keeps it, and an unknown level is refused", async () => {
		const gui = await setup();
		// A session that died before omp wrote its file, started with a model and a level.
		await Bun.write(
			path.join(gui.runtimeDir, "hosted", "0000000c.json"),
			JSON.stringify({
				guiId: "0000000c",
				startedAt: 1,
				cwd: gui.project,
				chat: false,
				prompt: "say hi",
				model: "deepseek/deepseek-flash",
				thinking: "low",
			}),
		);
		const served = await gui.start();
		const unknown = await gui.api<{ code: string }>(served, "/api/spawn", {
			project: gui.project,
			thinking: "turbo",
		});
		expect({ status: unknown.status, code: unknown.body.code }).toEqual({ status: 400, code: "bad-request" });

		const fresh = await gui.spawn(served, { project: gui.project, thinking: "auto" });
		expect(await gui.args(served, fresh.id)).toEqual(["--thinking", "auto"]);
		const restored = await gui.spawn(served, { from: "0000000c" });
		expect(await gui.args(served, restored.id)).toEqual([
			"--model",
			"deepseek/deepseek-flash",
			"--thinking",
			"low",
			"--",
			"say hi",
		]);
	}, 60_000);

	test("a session runs in the work-detail mode picked, a restore comes back in its recorded mode, and an unknown mode is refused", async () => {
		const gui = await setup();
		const hosted = path.join(gui.runtimeDir, "hosted");
		const { file } = await writeSessionFixture(gui.project, gui.project);
		// Sessions of a previous server: one omp saved, started in Verbose, and one that died before omp wrote
		// its file, started with a thinking level by a server that recorded no mode.
		await Bun.write(
			path.join(hosted, "0000000d.json"),
			JSON.stringify({
				guiId: "0000000d",
				sessionFile: file,
				startedAt: 1,
				cwd: gui.project,
				chat: false,
				workDetail: "verbose",
			}),
		);
		await Bun.write(
			path.join(hosted, "0000000e.json"),
			JSON.stringify({
				guiId: "0000000e",
				prompt: "say hi",
				thinking: "low",
				startedAt: 1,
				cwd: gui.project,
				chat: false,
			}),
		);
		const served = await gui.start();
		const unknown = await gui.api<{ code: string }>(served, "/api/spawn", {
			project: gui.project,
			workDetail: "terse",
		});
		expect({ status: unknown.status, code: unknown.body.code }).toEqual({ status: 400, code: "bad-request" });

		const fresh = await gui.spawn(served, { project: gui.project, workDetail: "compact" });
		expect(await gui.args(served, fresh.id)).toEqual(["--work-detail", "compact"]);
		// omp takes the mode and gets past its startup, rather than refusing the flag and exiting.
		await gui.waitForSessionFile(served, fresh.id);
		// Recorded with the session, so the next server restores it in the same mode.
		expect((await Bun.file(path.join(hosted, `${fresh.id}.json`)).json()).workDetail).toBe("compact");
		// The page sends its current pick on every spawn; a restore still comes back in the recorded mode.
		const continued = await gui.spawn(served, { from: "0000000d", workDetail: "compact" });
		expect(await gui.args(served, continued.id)).toEqual(["--restore", file, "--work-detail", "verbose"]);
		// With no mode recorded, the page's pick applies.
		const restarted = await gui.spawn(served, { from: "0000000e", workDetail: "standard" });
		expect(await gui.args(served, restarted.id)).toEqual([
			"--thinking",
			"low",
			"--work-detail",
			"standard",
			"--",
			"say hi",
		]);
	}, 60_000);

	test("a session runs in the approval mode picked, a restore keeps its recorded mode, and an unknown mode is refused", async () => {
		const gui = await setup();
		const hosted = path.join(gui.runtimeDir, "hosted");
		const { file } = await writeSessionFixture(gui.project, gui.project);
		// A session of a previous server, started in Always ask.
		await Bun.write(
			path.join(hosted, "0000000f.json"),
			JSON.stringify({
				guiId: "0000000f",
				sessionFile: file,
				startedAt: 1,
				cwd: gui.project,
				chat: false,
				approvalMode: "always-ask",
			}),
		);
		const served = await gui.start();
		const unknown = await gui.api<{ code: string }>(served, "/api/spawn", {
			project: gui.project,
			approvalMode: "never",
		});
		expect({ status: unknown.status, code: unknown.body.code }).toEqual({ status: 400, code: "bad-request" });

		const fresh = await gui.spawn(served, { project: gui.project, approvalMode: "auto" });
		expect(await gui.args(served, fresh.id)).toEqual(["--approval-mode", "auto"]);
		// omp takes the mode and gets past its startup, rather than refusing the flag and exiting.
		await gui.waitForSessionFile(served, fresh.id);
		expect((await Bun.file(path.join(hosted, `${fresh.id}.json`)).json()).approvalMode).toBe("auto");
		// The page's yolo pick never loosens a restored session that ran asking.
		const restored = await gui.spawn(served, { from: "0000000f", approvalMode: "yolo" });
		expect(await gui.args(served, restored.id)).toEqual(["--restore", file, "--approval-mode", "always-ask"]);
	}, 60_000);
	test("a mode switched with the session's chip is recorded, and a restore comes back in it", async () => {
		const gui = await setup();
		await gui.skipSetupWizard();
		const { file } = await writeSessionFixture(gui.project, gui.project);
		const first = await gui.start();
		const session = await gui.spawn(first, { resume: { path: file, cwd: gui.project }, workDetail: "compact" });
		const doc = async () => (await gui.api<DocNode | null>(first, `/api/doc?id=${session.id}&sf=s:1`)).body;
		const isChip = (node: DocNode) => node.p?.role === "omp.composer.detail";
		await waitFor(async () => findNode(await doc(), isChip) !== undefined, 30_000);
		const chip = findNode(await doc(), isChip)!;
		const ws = new WebSocket(`ws://127.0.0.1:${first.port}/pty?id=${session.id}&t=${first.token}`);
		const opened = Promise.withResolvers<void>();
		ws.addEventListener("open", () => opened.resolve());
		ws.addEventListener("error", () => opened.reject(new Error("the session socket did not open")));
		await opened.promise;
		const entryFile = path.join(gui.runtimeDir, "hosted", `${session.id}.json`);
		try {
			// Click the chip, as the page does; omp opens its picker on Compact. Two rows down is Verbose.
			ws.send(JSON.stringify({ t: "ev", ev: { ev: "action", sf: "s:1", id: chip.id, act: "detail.select" } }));
			await waitFor(async () => findNode(await doc(), node => node.k === "picker") !== undefined);
			ws.send(JSON.stringify({ t: "keys", data: "\x1b[B\x1b[B\r" }));
			await waitFor(async () => (await Bun.file(entryFile).json()).workDetail === "verbose");
		} finally {
			ws.close();
		}
		expect(await gui.stop(first)).toBe(143);

		const second = await gui.start();
		// The page sends its own pick; the restore still takes the mode the session last ran in.
		const restored = await gui.spawn(second, { from: session.id, workDetail: "compact" });
		expect(await gui.args(second, restored.id)).toEqual(["--restore", file, "--work-detail", "verbose"]);
	}, 90_000);
});

describe("omp gui: sessions that outlive or leave their server", () => {
	// Linux continues a stopped session leader when its terminal hangs up (SIGHUP, then SIGCONT), so the
	// omp ends with its server there; macOS leaves it stopped, as a wedged omp that ignores the hangup.
	test.skipIf(process.platform !== "darwin")(
		"a hung omp that outlived its server is listed as still running: Restore is refused and End stops it",
		async () => {
			const gui = await setup();
			const first = await gui.start();
			const session = await gui.spawn(first, { project: gui.project, prompt: "say hi" });
			gui.pin(session.pid);
			// Past its startup (it has reported its session file), omp catches SIGHUP; stopped then, it acts on
			// no signal but SIGKILL and answers nothing, as a hung omp. Stopped earlier, the hangup would kill it.
			await gui.waitForSessionFile(first, session.id);
			process.kill(session.pid, "SIGSTOP");
			process.kill(first.pid, "SIGKILL");
			await first.proc.exited;

			// The next server may run in another environment (a terminal's locale and zone, not the desktop's):
			// it still recognises the start time the first one recorded.
			const second = await gui.start([], "ignore", {
				LANG: "zh_CN.UTF-8",
				LC_ALL: "zh_CN.UTF-8",
				TZ: "Pacific/Kiritimati",
			});
			const [entry] = await gui.interrupted(second);
			expect(entry).toMatchObject({ guiId: session.id, orphan: true });
			// Restoring it would start a second agent on its first message beside the one still running.
			const restore = await gui.api<{ code: string }>(second, "/api/spawn", { from: session.id });
			expect({ status: restore.status, code: restore.body.code }).toEqual({ status: 409, code: "conflict" });
			expect(await gui.live(second)).toEqual([]);

			const ended = await gui.api<{ ok: boolean }>(second, "/api/interrupted/end", { guiId: session.id });
			expect(ended.body).toEqual({ ok: true });
			await waitFor(async () => processGone(session.pid));
			expect(await gui.interrupted(second)).toEqual([]);
		},
		90_000,
	);

	test("a recorded pid is signalled only while it is confirmed to be the session's omp", async () => {
		const gui = await setup();
		const hosted = path.join(gui.runtimeDir, "hosted");
		const recorded = { cwd: gui.project, chat: false, startedAt: 1, prompt: "say hi" };
		// A pid another process wears now (its start time is not the recorded one), and a pid recorded
		// without a start time (the server died before reading it): neither process is the test's omp.
		const reused = gui.sleeper();
		const unconfirmed = gui.sleeper();
		await Bun.write(
			path.join(hosted, "0000000a.json"),
			JSON.stringify({ guiId: "0000000a", pid: reused.pid, startToken: "not its start time", ...recorded }),
		);
		await Bun.write(
			path.join(hosted, "0000000b.json"),
			JSON.stringify({ guiId: "0000000b", pid: unconfirmed.pid, ...recorded }),
		);

		const served = await gui.start();
		const listed = Object.fromEntries((await gui.interrupted(served)).map(entry => [entry.guiId, entry.orphan]));
		expect(listed).toEqual({ "0000000a": false, "0000000b": true });
		// The unconfirmed one may still be that omp: it is not restored beside itself, and not signalled.
		const restore = await gui.api<{ code: string }>(served, "/api/spawn", { from: "0000000b" });
		expect({ status: restore.status, code: restore.body.code }).toEqual({ status: 409, code: "conflict" });
		for (const guiId of ["0000000a", "0000000b"]) {
			const end = await gui.api<{ code: string }>(served, "/api/interrupted/end", { guiId });
			expect({ guiId, status: end.status, code: end.body.code }).toEqual({ guiId, status: 409, code: "conflict" });
		}
		await Bun.sleep(200);
		expect([processGone(reused.pid), processGone(unconfirmed.pid)]).toEqual([false, false]);
		expect((await gui.interrupted(served)).map(entry => entry.guiId).sort()).toEqual(["0000000a", "0000000b"]);
		// The reused pid says nothing of the session: it restores as recorded.
		const restored = await gui.spawn(served, { from: "0000000a" });
		expect(await gui.args(served, restored.id)).toEqual(["--", "say hi"]);
	}, 30_000);

	test("End of an omp that exited by itself since it was listed keeps the session to restore", async () => {
		const gui = await setup();
		const omp = gui.sleeper();
		const startToken = await processStartToken(omp.pid);
		expect(startToken).not.toBeNull();
		// An omp of a server that died, still running when the next server read its entry.
		const entry = { guiId: "0000000a", cwd: gui.project, chat: false, startedAt: 1, prompt: "say hi" };
		await Bun.write(
			path.join(gui.runtimeDir, "hosted", "0000000a.json"),
			JSON.stringify({ ...entry, pid: omp.pid, startToken }),
		);
		const served = await gui.start();
		expect((await gui.interrupted(served)).map(entry => entry.orphan)).toEqual([true]);

		omp.kill("SIGKILL");
		await omp.exited;
		const end = await gui.api<{ code: string }>(served, "/api/interrupted/end", { guiId: "0000000a" });
		expect({ status: end.status, code: end.body.code }).toEqual({ status: 409, code: "conflict" });
		expect(await gui.interrupted(served)).toMatchObject([{ guiId: "0000000a", orphan: false, prompt: "say hi" }]);
	}, 30_000);

	test("after /new the first message is no longer the session's: a restore continues the new file", async () => {
		const gui = await setup();
		await gui.skipSetupWizard();
		const first = await gui.start();
		const session = await gui.spawn(first, {
			project: gui.project,
			prompt: "say hi",
			model: "deepseek/deepseek-flash",
		});
		const firstFile = await gui.waitForSessionFile(first, session.id);
		await gui.typeLine(first, session.id, "/new");
		const newFile = await gui.waitForSessionFile(first, session.id, firstFile);
		// omp names the new session's file before its first write, and with no model it never writes it:
		// stand in for the first turn after /new that omp persisted before the server stopped.
		await Bun.write(newFile, sessionJournal(crypto.randomUUID(), gui.project, ["a task after /new"]));
		expect(await gui.stop(first)).toBe(143);

		const second = await gui.start();
		const interrupted = await gui.interrupted(second);
		expect(interrupted.map(entry => [entry.guiId, entry.sessionFile, entry.prompt])).toEqual([
			[session.id, newFile, undefined],
		]);
		const restored = await gui.spawn(second, { from: session.id });
		expect(await gui.args(second, restored.id)).toEqual(["--restore", newFile]);
	}, 60_000);

	test("omp quitting cleanly is not offered again; a crash is, with its cause; an exited session can be dismissed", async () => {
		const gui = await setup();
		await gui.skipSetupWizard();
		const first = await gui.start();
		const spawnOne = () =>
			gui.spawn(first, { project: gui.project, prompt: "say hi", model: "deepseek/deepseek-flash" });
		const quit = await spawnOne();
		// The only omp typed into: let it draw its composer before the others start beside it.
		await gui.waitForEditor(first, quit.id);
		const crashed = await spawnOne();
		const dismissed = await spawnOne();
		const running = await gui.api<{ code: string }>(first, "/api/interrupted/dismiss", { guiId: dismissed.id });
		expect({ status: running.status, code: running.body.code }).toEqual({ status: 409, code: "conflict" });

		await gui.typeLine(first, quit.id, "/exit");
		process.kill(crashed.pid, "SIGKILL");
		process.kill(dismissed.pid, "SIGKILL");
		const ended = Object.fromEntries((await gui.waitForAllSettled(first)).map(session => [session.id, session]));
		expect(ended[quit.id]).toMatchObject({ exit: { code: 0, signal: null }, restorable: false });
		expect(ended[crashed.id]).toMatchObject({ exit: { code: null, signal: "SIGKILL" }, restorable: true });

		const dismiss = await gui.api<{ ok: boolean }>(first, "/api/interrupted/dismiss", { guiId: dismissed.id });
		expect(dismiss.body).toEqual({ ok: true });
		expect(new Set((await gui.live(first)).map(session => session.id))).toEqual(new Set([quit.id, crashed.id]));
		expect(await gui.stop(first)).toBe(143);

		const second = await gui.start();
		const interrupted = await gui.interrupted(second);
		expect(interrupted.map(entry => [entry.guiId, entry.exit])).toEqual([
			[crashed.id, { code: null, signal: "SIGKILL" }],
		]);
	}, 60_000);

	test("an entry a later restore names in restoredFrom is dropped, so its first message starts once", async () => {
		const gui = await setup();
		// What a crash between writing a restore's entry and removing the restored one leaves.
		const hosted = path.join(gui.runtimeDir, "hosted");
		const recorded = { cwd: gui.project, chat: false, prompt: "say hi" };
		await Bun.write(
			path.join(hosted, "0000000a.json"),
			JSON.stringify({ guiId: "0000000a", startedAt: 1, ...recorded }),
		);
		await Bun.write(
			path.join(hosted, "0000000b.json"),
			JSON.stringify({ guiId: "0000000b", startedAt: 2, restoredFrom: "0000000a", ...recorded }),
		);

		const served = await gui.start();
		expect((await gui.interrupted(served)).map(entry => entry.guiId)).toEqual(["0000000b"]);
		// Durably: the next server does not find it either.
		expect(await fs.readdir(hosted)).toEqual(["0000000b.json"]);
	}, 30_000);

	// As for the hung omp above: macOS leaves a stopped omp running when its server dies.
	test.skipIf(process.platform !== "darwin")(
		"a session ended while its server dies during the stop is never offered for restore",
		async () => {
			const gui = await setup();
			const first = await gui.start();
			const session = await gui.spawn(first, { project: gui.project, prompt: "say hi" });
			gui.pin(session.pid);
			await gui.waitForSessionFile(first, session.id);
			// Hung, omp outlives End's signal, and the server dies during the stop ladder.
			process.kill(session.pid, "SIGSTOP");
			const kill = gui.api(first, "/api/kill", { id: session.id }).catch(() => undefined);
			const entryFile = path.join(gui.runtimeDir, "hosted", `${session.id}.json`);
			await waitFor(
				async () =>
					(
						await Bun.file(entryFile)
							.json()
							.catch(() => ({}))
					).ending === true,
			);
			process.kill(first.pid, "SIGKILL");
			await first.proc.exited;
			await kill;

			const second = await gui.start();
			expect(await gui.interrupted(second)).toMatchObject([{ guiId: session.id, orphan: true, ending: true }]);
			const restore = await gui.api<{ code: string }>(second, "/api/spawn", { from: session.id });
			expect({ status: restore.status, code: restore.body.code }).toEqual({ status: 409, code: "conflict" });
		},
		90_000,
	);

	test("an ended entry is dropped once its omp is gone; while that omp runs, dismissing it needs force", async () => {
		const gui = await setup();
		const hosted = path.join(gui.runtimeDir, "hosted");
		const recorded = { cwd: gui.project, chat: false, startedAt: 1, prompt: "say hi", ending: true };
		// What a server that died while ending two sessions leaves: one omp gone since, one still running.
		const gone = Bun.spawn(["true"]);
		await gone.exited;
		const omp = gui.sleeper();
		const startToken = await processStartToken(omp.pid);
		await Bun.write(
			path.join(hosted, "0000000a.json"),
			JSON.stringify({ guiId: "0000000a", pid: gone.pid, startToken: "not its start time", ...recorded }),
		);
		await Bun.write(
			path.join(hosted, "0000000b.json"),
			JSON.stringify({ guiId: "0000000b", pid: omp.pid, startToken, ...recorded }),
		);

		const served = await gui.start();
		expect(await gui.interrupted(served)).toMatchObject([{ guiId: "0000000b", orphan: true, ending: true }]);
		expect(await fs.readdir(hosted)).toEqual(["0000000b.json"]);
		// Forgetting it would leave its omp running with no way to end it from here.
		const refused = await gui.api<{ code: string }>(served, "/api/interrupted/dismiss", { guiId: "0000000b" });
		expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 409, code: "conflict" });
		const forced = await gui.api<{ ok: boolean }>(served, "/api/interrupted/dismiss", {
			guiId: "0000000b",
			force: true,
		});
		expect(forced.body).toEqual({ ok: true });
		expect(await gui.interrupted(served)).toEqual([]);
		expect(processGone(omp.pid)).toBe(false);
	}, 30_000);

	test("a session file with no message holds nothing to restore, as no file: only a first message restarts it", async () => {
		const gui = await setup();
		const hosted = path.join(gui.runtimeDir, "hosted");
		const recorded = { cwd: gui.project, chat: false, startedAt: 1 };
		// The file /new writes at once: a header, no message.
		const header = await writeSessionFixture(gui.project, gui.project, []);
		const alsoHeader = await writeSessionFixture(gui.project, gui.project, []);
		// A file omp created and never wrote: it opens its file before the first append, and a crash can come between.
		const blank = path.join(gui.project, "blank.jsonl");
		await Bun.write(blank, "");
		const entries: Record<string, { sessionFile: string; prompt?: string }> = {
			"0000000a": { sessionFile: header.file },
			"0000000b": { sessionFile: alsoHeader.file, prompt: "say hi" },
			"0000000c": { sessionFile: blank, prompt: "say hello" },
		};
		for (const [guiId, entry] of Object.entries(entries))
			await Bun.write(path.join(hosted, `${guiId}.json`), JSON.stringify({ guiId, ...entry, ...recorded }));

		const served = await gui.start();
		// Listed with no file to continue, so the page says Restore starts the first message again, as it does.
		const listed = await gui.interrupted(served);
		expect(listed.map(entry => [entry.guiId, entry.sessionFile ?? null, entry.prompt]).sort()).toEqual([
			["0000000b", null, "say hi"],
			["0000000c", null, "say hello"],
		]);
		expect((await fs.readdir(hosted)).sort()).toEqual(["0000000b.json", "0000000c.json"]);
		for (const [guiId, prompt] of [
			["0000000b", "say hi"],
			["0000000c", "say hello"],
		]) {
			const restored = await gui.spawn(served, { from: guiId });
			expect(await gui.args(served, restored.id)).toEqual(["--", prompt]);
		}
	}, 30_000);

	test.skipIf(process.getuid?.() === 0)(
		"a session file the server cannot read counts as saved: it is never traded for a restart of its first message",
		async () => {
			const gui = await setup();
			const { file } = await writeSessionFixture(gui.project, gui.project);
			await fs.chmod(file, 0o000);
			const entry = { cwd: gui.project, chat: false, startedAt: 1, sessionFile: file, prompt: "say hi" };
			await Bun.write(
				path.join(gui.runtimeDir, "hosted", "0000000a.json"),
				JSON.stringify({ guiId: "0000000a", ...entry }),
			);

			const served = await gui.start();
			const listed = [{ guiId: "0000000a", sessionFile: file, prompt: "say hi" }];
			expect(await gui.interrupted(served)).toMatchObject(listed);
			// Its restore cannot check the file either: it reports that, starts nothing, and the session stays.
			const restore = await gui.api<{ code: string }>(served, "/api/spawn", { from: "0000000a" });
			expect({ status: restore.status, code: restore.body.code }).toEqual({ status: 500, code: "internal" });
			expect(await gui.live(served)).toEqual([]);
			expect(await gui.interrupted(served)).toMatchObject(listed);
		},
		30_000,
	);

	test.skipIf(process.getuid?.() === 0)(
		"a session the roster cannot record is refused before its omp starts",
		async () => {
			const gui = await setup();
			const served = await gui.start();
			const hosted = path.join(gui.runtimeDir, "hosted");
			await fs.mkdir(hosted, { recursive: true });
			await fs.chmod(hosted, 0o500);
			try {
				const refused = await gui.api<{ code: string }>(served, "/api/spawn", { project: gui.project });
				expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 500, code: "internal" });
				expect(await gui.live(served)).toEqual([]);
			} finally {
				await fs.chmod(hosted, 0o700);
			}
		},
		30_000,
	);
});

describe("omp gui: session pins", () => {
	test("sessions order by their last message, not by an exit record written after it", async () => {
		const gui = await setup();
		const store = path.join(gui.home, ".omp", "agent", "sessions", "-project");
		const write = async (name: string, sent: string, extra: Record<string, unknown>[] = []) => {
			const id = crypto.randomUUID();
			const message = { role: "user", content: [{ type: "text", text: name }], timestamp: Date.parse(sent) };
			const lines = [
				{ type: "session", version: 3, id, timestamp: sent, cwd: gui.project },
				{ type: "message", id: "m1", parentId: null, timestamp: sent, message },
				...extra,
			];
			await Bun.write(path.join(store, `${id}.jsonl`), `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
			return id;
		};
		const talked = await write("newer talk", "2026-03-02T00:00:00.000Z");
		const exited = await write("older talk", "2026-03-01T00:00:00.000Z", [
			{
				type: "custom",
				customType: "session_exit",
				data: {},
				id: "x1",
				parentId: "m1",
				timestamp: "2026-03-03T00:00:00.000Z",
			},
		]);
		const served = await gui.start();
		const { projects } = (
			await gui.api<{ projects: { sessions: { id: string; modified: string }[] }[] }>(served, "/api/sessions")
		).body;

		expect(projects[0]!.sessions.map(session => session.id)).toEqual([talked, exited]);
		expect(projects[0]!.sessions[1]!.modified).toBe("2026-03-01T00:00:00.000Z");
	}, 30_000);

	test("a pinned session lists first and stays listed past the project's cap, until it is unpinned", async () => {
		const gui = await setup();
		const store = path.join(gui.home, ".omp", "agent", "sessions", "-project");
		const sessions: string[] = [];
		for (let index = 0; index < 52; index++) {
			const { file, id } = await writeSessionFixture(store, gui.project, [`task ${index}`]);
			// Written and dated oldest first: session 0 is the one the project's newest fifty leave out.
			const time = new Date(Date.UTC(2026, 0, 1, 0, index));
			await fs.utimes(file, time, time);
			sessions.push(id);
		}
		const served = await gui.start();
		const listed = async () => {
			const { projects } = (
				await gui.api<{ projects: { sessions: { id: string; pinned?: boolean }[] }[] }>(served, "/api/sessions")
			).body;
			return projects[0]!.sessions;
		};
		expect((await listed()).map(session => session.id)).not.toContain(sessions[0]);

		expect((await gui.api(served, "/api/pin", { id: sessions[0], pinned: true })).status).toBe(200);
		const pinned = await listed();
		expect(pinned[0]).toMatchObject({ id: sessions[0], pinned: true });
		expect(pinned).toHaveLength(51);

		expect((await gui.api(served, "/api/pin", { id: sessions[0], pinned: false })).status).toBe(200);
		expect((await listed()).map(session => session.id)).not.toContain(sessions[0]);
		expect((await gui.api(served, "/api/pin", { id: sessions[0] })).status).toBe(400);
	}, 30_000);
});

describe("omp gui: page preferences over the wire", () => {
	test("a saved preference reads back, and a key or value the page does not keep is refused", async () => {
		const gui = await setup();
		const served = await gui.start();
		expect((await gui.api(served, "/api/prefs")).body).toEqual({});

		expect((await gui.api(served, "/api/prefs", { key: "theme", value: "dark" })).status).toBe(200);
		expect((await gui.api(served, "/api/prefs")).body).toEqual({ theme: "dark" });
		expect((await gui.api(served, "/api/prefs", { key: "token", value: "x" })).status).toBe(400);
		expect((await gui.api(served, "/api/prefs", { key: "theme", value: 3 })).status).toBe(400);
		expect((await gui.api(served, "/api/prefs")).body).toEqual({ theme: "dark" });
	}, 30_000);

	test("two windows pinning different projects at once keep both, in the order pinned", async () => {
		const gui = await setup();
		const served = await gui.start();
		const pin = (root: string, pinned: boolean) => gui.api(served, "/api/project-pin", { root, pinned });
		const pinned = async () =>
			JSON.parse((await gui.api<{ pinnedProjects?: string }>(served, "/api/prefs")).body.pinnedProjects ?? "[]");

		const results = await Promise.all([pin("/work/a", true), pin("/work/b", true)]);
		expect(results.map(result => result.status)).toEqual([200, 200]);
		expect(await pinned()).toEqual(["/work/a", "/work/b"]);

		expect((await pin("/work/a", false)).status).toBe(200);
		expect(await pinned()).toEqual(["/work/b"]);
		expect((await pin("relative", true)).status).toBe(400);
	}, 30_000);
});

describe("omp gui: a folder's project", () => {
	test("a folder inside a checkout belongs to the checkout, and one outside any to itself", async () => {
		const gui = await setup();
		const repo = path.join(gui.home, "repo");
		const inside = path.join(repo, "notes", "drafts");
		const loose = path.join(gui.home, "loose");
		await fs.mkdir(inside, { recursive: true });
		await fs.mkdir(loose);
		expect((await Bun.$`git init -q ${repo}`.quiet().nothrow()).exitCode).toBe(0);
		const served = await gui.start();
		const root = async (dir: string) =>
			gui.api<{ root?: string }>(served, `/api/project-root?dir=${encodeURIComponent(dir)}`);

		expect((await root(inside)).body.root).toBe(repo);
		expect((await root(loose)).body.root).toBe(loose);
		expect((await root("relative/dir")).status).toBe(400);
	}, 30_000);
});

describe("omp gui: resume dedupe", () => {
	test("resuming a file the GUI already hosts returns that session", async () => {
		const gui = await setup();
		const served = await gui.start();
		const { file } = await writeSessionFixture(gui.project, gui.project);
		const resume = { resume: { path: file, cwd: gui.project } };

		const [a, b] = await Promise.all([
			gui.api<{ id: string }>(served, "/api/spawn", resume),
			gui.api<{ id: string }>(served, "/api/spawn", resume),
		]);
		expect(a.status).toBe(200);
		expect(b.body.id).toBe(a.body.id);
		const again = await gui.api<{ id: string; existing?: boolean }>(served, "/api/spawn", resume);
		expect(again.body).toEqual({ id: a.body.id, existing: true });
		const live = await gui.live(served);
		for (const session of live) await gui.api(served, "/api/kill", { id: session.id });
		expect(live.map(session => session.id)).toEqual([a.body.id]);
	}, 30_000);

	test("a session held by another process is waited for, then refused", async () => {
		const gui = await setup();
		const served = await gui.start();
		const { file, id } = await writeSessionFixture(gui.project, gui.project);
		const resume = { resume: { path: file, cwd: gui.project } };

		const held = tryAcquireSessionLease(id);
		expect(held).not.toBeNull();
		const refused = await gui.api<{ code: string }>(served, "/api/spawn", resume).finally(() => held?.release());
		expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 409, code: "conflict" });
		expect(await gui.live(served)).toEqual([]);

		// An owner that lets go while the resume waits (a session still tearing down) is not a conflict.
		const tearingDown = tryAcquireSessionLease(id);
		setTimeout(() => tearingDown?.release(), 1000);
		const resumed = await gui.api<{ id: string }>(served, "/api/spawn", resume);
		expect(resumed.status).toBe(200);
		await gui.api(served, "/api/kill", { id: resumed.body.id });
	}, 40_000);
});
