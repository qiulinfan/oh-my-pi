import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLoginShellEnv } from "../src/login-shell";

let dir: string;
/** rc background jobs not yet seen to exit; one seen to exit is dropped, since its pid may be reused. */
const strays = new Set<number>();

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-desktop-shell-"));
});

afterEach(async () => {
	for (const pid of strays) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	strays.clear();
	await fs.rm(dir, { recursive: true, force: true });
});

/** A stand-in login shell: runs `rc`, then the dump it is given as `-ilc <dump>`. */
async function fakeShell(rc: string): Promise<string> {
	const file = path.join(dir, "shell");
	await Bun.write(file, `#!/bin/sh\n${rc}\nexec /bin/sh -c "$2"\n`);
	await fs.chmod(file, 0o755);
	return file;
}

/** rc lines that start a background job and record its pid by rename, so the pid file is complete whenever it exists. */
function stray(): string {
	return `sleep 30 & echo $! > "${dir}/pid.tmp" && mv "${dir}/pid.tmp" "${dir}/pid"`;
}

async function strayPid(): Promise<number> {
	const text = await Bun.file(path.join(dir, "pid")).text();
	const pid = Number(text.trim());
	// Never 0 or 1: a signal to 0 reaches this test runner's whole process group.
	if (!/^\d+\n$/.test(text) || pid <= 1) throw new Error(`unexpected pid file: ${JSON.stringify(text)}`);
	strays.add(pid);
	return pid;
}

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (running(pid)) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(25);
	}
	strays.delete(pid);
	return true;
}

const base: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/nonexistent", PWD: "/elsewhere" };

describe("readLoginShellEnv", () => {
	test("completes at the closing delimiter although an rc background job holds stdout", async () => {
		const shell = await fakeShell(`${stray()}; export FROM_RC=yes`);
		const started = Date.now();
		const result = await readLoginShellEnv({ base, shell, cwd: dir, timeoutMs: 5_000 });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.failure).toBeUndefined();
		expect(result.env.FROM_RC).toBe("yes");
		// The probe shell's own session variables never reach omp, nor does the launcher's stale PWD.
		expect(Object.keys(result.env).filter(key => ["PWD", "OLDPWD", "SHLVL", "_"].includes(key))).toEqual([]);
		// rc-started jobs (an ssh agent, say) are the user's and keep running.
		expect(running(await strayPid())).toBe(true);
	});

	test("an rc that reads stdin gets EOF instead of hanging", async () => {
		const shell = await fakeShell("read line; export AFTER_READ=yes");
		const result = await readLoginShellEnv({ base, shell, cwd: dir, timeoutMs: 5_000 });
		expect(result.failure).toBeUndefined();
		expect(result.env.AFTER_READ).toBe("yes");
	});

	test("a shell that hangs times out and its whole process group is killed", async () => {
		const shell = await fakeShell(`${stray()}; wait; export FROM_RC=yes`);
		const started = Date.now();
		const result = await readLoginShellEnv({ base, shell, cwd: dir, timeoutMs: 400 });
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(result.failure).toBe("timeout");
		expect(result.env.FROM_RC).toBeUndefined();
		expect(result.env.PATH).toBe(base.PATH);
		expect(await exitsWithin(await strayPid(), 2_000)).toBe(true);
	});

	test("aborting a read in flight kills its process group", async () => {
		const shell = await fakeShell(`${stray()}; wait`);
		const probe = new AbortController();
		const reading = readLoginShellEnv({ base, shell, cwd: dir, timeoutMs: 10_000, signal: probe.signal });
		const pidFile = Bun.file(path.join(dir, "pid"));
		while (!(await pidFile.exists())) await Bun.sleep(10);
		probe.abort();
		expect((await reading).failure).toBe("aborted");
		expect(await exitsWithin(await strayPid(), 2_000)).toBe(true);
	});

	test("a shell that exits without the dump, or cannot start, falls back to the inherited environment", async () => {
		const exiting = await readLoginShellEnv({ base, shell: await fakeShell("exit 3"), cwd: dir, timeoutMs: 5_000 });
		expect(exiting.failure).toBe("exit 3");
		expect(exiting.env.PATH).toBe(base.PATH);

		const missing = await readLoginShellEnv({ base, shell: path.join(dir, "no-such-shell"), cwd: dir });
		expect(missing.failure).toContain("ENOENT");
		expect(missing.env.PATH).toBe(base.PATH);
	});
});
