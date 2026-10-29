/**
 * Contract tests for how far the GUI's stop ladder reaches beyond omp: its hard kill and, once omp has
 * exited, its sweep end what is in the process group omp led (a terminal would have ended it with omp),
 * never a daemon omp started detached so it outlives omp (the daemon broker, the shared embedding server)
 * and serves other omp processes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { groupBelow, killGroup, killLeftovers } from "../src/gui/process-group";

/** A stand-in for omp: a child in its group that ignores the hangup, and a detached daemon. */
const STAND_IN = `
const quiet = { stdin: "ignore", stdout: "ignore", stderr: "ignore" };
const stays = Bun.spawn(["sh", "-c", "trap '' HUP; exec sleep 120"], quiet);
const daemon = Bun.spawn(["sleep", "120"], { ...quiet, detached: true });
console.log(JSON.stringify({ stays: stays.pid, daemon: daemon.pid }));
setInterval(() => {}, 1000);
`;

interface StandIn {
	root: Bun.Subprocess;
	rootRef: Process;
	daemonRef: Process;
	/** The pid of the child in the stand-in's group. */
	stays: number;
}

let started: Bun.Subprocess | undefined;
/** Every process a test started, pinned while known to be the test's own. */
const pinned: Process[] = [];

afterEach(async () => {
	// Each one only while it still runs as itself, read through its pinned reference just before the signal.
	for (const ref of pinned.splice(0)) {
		if (ref.status() !== ProcessStatus.Running) continue;
		try {
			process.kill(ref.pid, "SIGKILL");
		} catch {}
	}
	started?.kill("SIGKILL");
	await started?.exited;
	started = undefined;
});

/** Run the stand-in in its own terminal, as the GUI server runs omp: the session leader, leading its group. */
async function startStandIn(): Promise<StandIn> {
	let output = "";
	const decoder = new TextDecoder();
	const root = Bun.spawn([process.execPath, "-e", STAND_IN], {
		terminal: { cols: 80, rows: 24, data: (_term, bytes) => (output += decoder.decode(bytes)) },
	});
	started = root;
	const deadline = Date.now() + 10_000;
	while (!/\{[^}]*\}/.test(output)) {
		if (Date.now() > deadline) throw new Error(`the stand-in printed nothing: ${output}`);
		await Bun.sleep(50);
	}
	const { stays, daemon } = JSON.parse(/\{[^}]*\}/.exec(output)![0]) as { stays: number; daemon: number };
	const daemonRef = Process.fromPid(daemon)!;
	const rootRef = Process.fromPid(root.pid)!;
	pinned.push(daemonRef, rootRef);
	return { root, rootRef, daemonRef, stays };
}

describe.skipIf(process.platform === "win32")("gui stop ladder: omp's process group", () => {
	test("once omp has exited, what it left in its process group is killed and a detached daemon is not", async () => {
		const { root, rootRef, daemonRef, stays } = await startStandIn();
		const left = groupBelow(rootRef);
		pinned.push(...left);
		expect(left.map(leftover => leftover.pid)).toEqual([stays]);

		root.kill("SIGKILL");
		await root.exited;
		expect(await killLeftovers(root.pid, left, 300)).toBe(1);
		expect(await left[0]!.waitForExit({ timeoutMs: 2000 })).toBe(true);
		expect(daemonRef.status()).toBe(ProcessStatus.Running);
	}, 30_000);

	test("the hard kill ends omp and its process group, never a daemon it detached", async () => {
		const { root, rootRef, daemonRef, stays } = await startStandIn();
		const staysRef = Process.fromPid(stays)!;
		pinned.push(staysRef);

		expect(killGroup(rootRef)).toBe(true);
		await root.exited;
		expect(root.signalCode).toBe("SIGKILL");
		expect(await staysRef.waitForExit({ timeoutMs: 2000 })).toBe(true);
		expect(daemonRef.status()).toBe(ProcessStatus.Running);
		// Once omp is gone its pinned reference signals nothing, whoever wears its pid now.
		expect(killGroup(rootRef)).toBe(false);
	}, 30_000);
});
