import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	Budget,
	countLive,
	crashLogName,
	fetchLive,
	findOmp,
	GuiProcess,
	GuiStartError,
	pingGui,
	quitQuestion,
	StderrTail,
	writeCrashLog,
} from "../src/supervisor";

let dir: string;
const children: GuiProcess[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-supervisor-"));
});

afterEach(async () => {
	for (const proc of children.splice(0)) if (proc.alive) proc.child.kill("SIGKILL");
	for (const server of servers.splice(0)) server.stop(true);
	await fs.rm(dir, { recursive: true, force: true });
});

/** A stand-in `omp` that runs `body` with /bin/sh. */
async function fakeOmp(body: string): Promise<GuiProcess> {
	const file = path.join(dir, `omp-${children.length}`);
	await Bun.write(file, `#!/bin/sh\n${body}\n`);
	await fs.chmod(file, 0o755);
	const proc = new GuiProcess(file, { PATH: "/usr/bin:/bin" });
	children.push(proc);
	return proc;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error("expected a rejection");
}

describe("Budget", () => {
	test("allows two restarts in a minute, refuses the third, and recovers as the window slides", () => {
		const budget = new Budget(2, 60_000);
		expect(budget.take(0)).toBe(true);
		expect(budget.take(10_000)).toBe(true);
		expect(budget.take(20_000)).toBe(false);
		// The refused attempt spent nothing: once the first falls out of the window, one more is allowed.
		expect(budget.take(60_001)).toBe(true);
		expect(budget.take(60_002)).toBe(false);
		budget.reset();
		expect(budget.take(60_003)).toBe(true);
	});
});

test("StderrTail keeps only the newest output", () => {
	const tail = new StderrTail(12);
	tail.push("first line\n");
	tail.push("second\nthird\n");
	expect(tail.text).toBe("second\nthird\n".slice(-12));
	expect(tail.lastLines(1)).toBe("third");
});

describe("findOmp", () => {
	/** An `omp` file in its own directory under the test dir; executable unless `mode` says otherwise. */
	async function ompIn(sub: string, mode = 0o755): Promise<string> {
		const file = path.join(dir, sub, "omp");
		await Bun.write(file, "#!/bin/sh\n");
		await fs.chmod(file, mode);
		return file;
	}

	test("a named omp that cannot be run fails instead of falling back to the omp on PATH", async () => {
		const onPath = await ompIn("path");
		const searchPath = path.dirname(onPath);
		const notExecutable = await ompIn("named", 0o644);
		for (const named of [notExecutable, path.join(dir, "missing", "omp"), "named/omp"]) {
			const err = await rejection(findOmp(named, searchPath, dir));
			expect((err as Error).message).toContain("OMP_DESKTOP_OMP");
			expect((err as Error).message).toContain(named);
		}
	});

	test("a named omp that can be run wins over PATH and ~/.local/bin", async () => {
		const onPath = await ompIn("path");
		await ompIn(".local/bin");
		const named = await ompIn("named");
		expect(await findOmp(named, path.dirname(onPath), dir)).toBe(named);
	});

	test("without a named omp: the first runnable omp on PATH, then ~/.local/bin, else an error", async () => {
		const notExecutable = await ompIn("first", 0o644);
		const runnable = await ompIn("second");
		const home = await ompIn(".local/bin");
		const searchPath = [path.dirname(notExecutable), path.dirname(runnable)].join(path.delimiter);
		expect(await findOmp(undefined, searchPath, dir)).toBe(runnable);
		expect(await findOmp(undefined, path.dirname(notExecutable), dir)).toBe(home);
		await fs.rm(home);
		expect(String(await rejection(findOmp(undefined, path.dirname(notExecutable), dir)))).toContain(
			"omp was not found",
		);
	});
});

describe("GuiProcess handshake", () => {
	test("resolves with the announced address, skipping other stdout lines", async () => {
		const proc = await fakeOmp(
			`echo "warming up"; echo '{"pid":41,"port":4317,"token":"t","url":"http://127.0.0.1:4317/?t=t","attached":true}'`,
		);
		expect(await proc.ready(5_000)).toEqual({
			pid: 41,
			port: 4317,
			token: "t",
			url: "http://127.0.0.1:4317/?t=t",
			attached: true,
		});
	});

	test("an {error, pid} line is a failure naming the unresponsive server", async () => {
		const proc = await fakeOmp(`echo '{"error":"the GUI server (pid 4242) is not responding","pid":4242}'; exit 1`);
		const err = await rejection(proc.ready(5_000));
		expect(err).toBeInstanceOf(GuiStartError);
		expect((err as GuiStartError).serverPid).toBe(4242);
		expect((err as Error).message).toContain("not responding");
	});

	test("an exit before announcing fails with the exit status, and stderr is kept", async () => {
		const proc = await fakeOmp("echo boom >&2; exit 3");
		const err = await rejection(proc.ready(5_000));
		expect((err as Error).message).toContain("exited with code 3");
		expect(proc.stderr.text).toContain("boom");
	});

	test("a child that never announces is stopped when the timeout fails it", async () => {
		const proc = await fakeOmp("exec sleep 30");
		const err = await rejection(proc.ready(300));
		expect((err as Error).message).toContain("did not report its address");
		expect(proc.alive).toBe(false);
	});

	test("an address announced while the timeout stops the child is not accepted", async () => {
		const proc = await fakeOmp(
			`line='{"pid":41,"port":4317,"token":"t","url":"http://127.0.0.1:4317/?t=t"}'; trap 'echo "$line"; exit 0' TERM; while :; do sleep 0.05; done`,
		);
		const err = await rejection(proc.ready(300));
		expect((err as Error).message).toContain("did not report its address");
		expect(proc.alive).toBe(false);
	});
});

describe("GuiProcess.stop", () => {
	test("a child that ignores SIGTERM is killed after the grace period", async () => {
		const proc = await fakeOmp(`trap '' TERM; echo ready >&2; while :; do sleep 0.05; done`);
		while (!proc.stderr.text.includes("ready")) await Bun.sleep(10);
		expect(await proc.stop(200, 2_000)).toBe(true);
		expect((await proc.exited).signal).toBe("SIGKILL");
	});

	test("a child that exits on SIGTERM is not escalated", async () => {
		const proc = await fakeOmp("exec sleep 30");
		await Bun.sleep(50);
		expect(await proc.stop(2_000, 2_000)).toBe(true);
		expect((await proc.exited).signal).toBe("SIGTERM");
	});
});

describe("pingGui", () => {
	let reply: () => Response | Promise<Response>;
	let port: number;

	beforeEach(() => {
		const server = Bun.serve({ port: 0, fetch: () => reply() });
		servers.push(server);
		port = server.port as number;
	});

	const endpoint = () => ({ pid: 7, port, token: "t", bootId: "boot-a" });

	test("the run this app connected to is ok, and says whether omp was reinstalled", async () => {
		reply = () => Response.json({ pid: 7, bootId: "boot-a", replaced: true });
		expect(await pingGui(endpoint(), endpoint())).toEqual({ state: "ok", pid: 7, bootId: "boot-a", replaced: true });
	});

	test.each([
		["another boot on the same port", () => Response.json({ pid: 7, bootId: "boot-b" })],
		["another pid on the same port", () => Response.json({ pid: 8, bootId: "boot-a" })],
		[
			"another token (a different server took the port)",
			() => Response.json({ error: "forbidden" }, { status: 403 }),
		],
	])("%s is gone", async (_name, answer) => {
		reply = answer;
		expect((await pingGui(endpoint(), endpoint())).state).toBe("gone");
	});

	test("a server that is stopping is not gone", async () => {
		reply = () => Response.json({ pid: 7, bootId: "boot-a", stopping: true }, { status: 503 });
		expect((await pingGui(endpoint(), endpoint())).state).toBe("stopping");
	});

	test("no answer in time is slow, not gone", async () => {
		reply = () => Promise.withResolvers<Response>().promise;
		expect((await pingGui(endpoint(), endpoint(), 200)).state).toBe("slow");
	});

	test("a closed port is gone", async () => {
		servers.splice(0).forEach(server => server.stop(true));
		await Bun.sleep(20);
		expect((await pingGui(endpoint(), endpoint())).state).toBe("gone");
	});
});

describe("the quit check", () => {
	let reply: () => Response | Promise<Response>;
	let port: number;

	beforeEach(() => {
		const server = Bun.serve({ port: 0, fetch: () => reply() });
		servers.push(server);
		port = server.port as number;
	});

	const inspect = (timeoutMs?: number) => fetchLive({ pid: 7, port, token: "t" }, timeoutMs).then(countLive);

	test("counts the sessions quitting would end, and which of them are working", async () => {
		reply = () =>
			Response.json([
				{ id: "a", busy: true, stopping: false, exited: false },
				{ id: "b", busy: false, stopping: false, exited: false },
				{ id: "c", busy: false, stopping: false, exited: true },
				{ id: "d", busy: true, stopping: true, exited: false },
			]);
		expect(await inspect()).toEqual({ live: 2, working: 1 });
	});

	test.each([
		["an error status", () => Response.json({ error: "x", code: "forbidden" }, { status: 403 })],
		["a body that is not JSON", () => new Response("<html>")],
		["a body that is not a list", () => Response.json({ live: [] })],
		["an entry without an id", () => Response.json([{ busy: true }])],
		["no answer in time", () => Promise.withResolvers<Response>().promise],
	])("%s is unknown, never 'nothing running'", async (_name, answer) => {
		reply = answer;
		expect(await inspect(200)).toBe("unknown");
	});

	test("asks before quitting when sessions would end or when it cannot tell, and only then", () => {
		expect(quitQuestion({ live: 0, working: 0 })).toBeNull();
		expect(quitQuestion("unknown")).not.toBeNull();
		expect(quitQuestion({ live: 2, working: 1 })?.message).toContain("2 sessions (1 working)");
	});
});

describe("crash logs", () => {
	const report = (time: Date) => ({
		time,
		reason: "the GUI server was killed by SIGKILL",
		omp: "/usr/local/bin/omp",
		pid: 99,
		port: 4317,
		token: "0123456789abcdef0123456789abcdef",
		loginShell: "/opt/homebrew/bin/fish",
		live: null,
		stderr: "fatal: request with ?t=0123456789abcdef0123456789abcdef failed\n",
	});

	test("are owner-only and never hold the token", async () => {
		const logs = path.join(dir, "logs");
		const file = await writeCrashLog(logs, {
			...report(new Date("2026-10-26T12:00:00.000Z")),
			// What Electron's loadURL rejects with: the page URL, token included.
			reason:
				"could not connect: ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:4317/?t=0123456789abcdef0123456789abcdef&shell=desktop'",
		});
		expect(file).toBe(path.join(logs, "crash-2026-10-26T12-00-00-000Z-server.log"));
		expect((await fs.stat(logs)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(file as string)).mode & 0o777).toBe(0o600);
		const text = await Bun.file(file as string).text();
		expect(text).not.toContain("0123456789abcdef0123456789abcdef");
		expect(text).toContain("fatal: request with ?t=<token> failed");
		expect(text).toContain("loading 'http://127.0.0.1:4317/?t=<token>&shell=desktop'");
	});

	test("keep the newest ten and leave other files alone", async () => {
		const logs = path.join(dir, "logs");
		await fs.mkdir(logs);
		await Bun.write(path.join(logs, "omp-desktop.log"), "unrelated");
		const times = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 9, 26, 12, 0, i)));
		for (const time of times) await writeCrashLog(logs, report(time));
		const names = (await fs.readdir(logs)).sort();
		expect(names).toEqual([...times.slice(2).map(crashLogName), "omp-desktop.log"].sort());
	});
});
