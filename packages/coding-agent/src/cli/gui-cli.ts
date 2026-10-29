/**
 * `omp gui`: attach to the GUI server of this runtime directory, or serve it
 * from this process until interrupted.
 */
import type { FileLockHandle } from "@oh-my-pi/pi-utils";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import {
	acquireGuiLease,
	type GuiRuntime,
	guiHostedDir,
	loadGuiToken,
	probeGui,
	publishGui,
	readRuntime,
	removeStaleGuiTemps,
	retractGui,
} from "../gui/runtime";
import { type GuiServer, startGuiServer } from "../gui/server";
import { openPath } from "../utils/open";

export interface GuiCommandArgs {
	port: number;
	open: boolean;
	json: boolean;
	/** Stop the server, and the sessions it hosts, when stdin closes (the desktop app's lifeline). */
	exitOnStdinClose: boolean;
}

/** How long a lease holder that does not answer may take before `omp gui` gives up on it. */
const NOT_RESPONDING_MS = 5000;
/** How long a lease holder that says it is stopping may take. */
const STOPPING_MS = 20_000;
const RETRY_MS = 200;

function announce(runtime: GuiRuntime, json: boolean, attached: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify({ ...runtime, attached })}\n`);
		return;
	}
	process.stdout.write(`${attached ? "omp gui is already running" : "omp gui"}: ${runtime.url}\n`);
}

function failGui(cmd: GuiCommandArgs, error: string, pid: number | undefined): void {
	if (cmd.json) process.stdout.write(`${JSON.stringify({ error, pid })}\n`);
	else process.stderr.write(`omp gui: ${error}\n`);
	process.exitCode = 1;
}

/**
 * Serve while holding the lease, or attach to the server that holds it. A
 * holder that does not answer is reported, never replaced: a second server
 * would split the sessions between two addresses.
 */
export async function runGuiCommand(cmd: GuiCommandArgs): Promise<void> {
	const start = Date.now();
	let deadline = start + NOT_RESPONDING_MS;
	for (;;) {
		const lease = await acquireGuiLease();
		if (lease) return serveGui(cmd, lease);
		const probe = await probeGui();
		if (probe.state === "up") {
			announce(probe.runtime, cmd.json, true);
			if (cmd.open) openPath(probe.runtime.url);
			return;
		}
		// A stopping server releases the lease once its sessions are down; give it the longer deadline.
		if (probe.state === "stopping") deadline = start + STOPPING_MS;
		if (Date.now() >= deadline) {
			const pid = probe.runtime?.pid ?? (await readRuntime())?.pid;
			const who = pid === undefined ? "the GUI server" : `the GUI server (pid ${pid})`;
			failGui(cmd, probe.state === "stopping" ? `${who} is still stopping` : `${who} is not responding`, pid);
			return;
		}
		await Bun.sleep(RETRY_MS);
	}
}

async function serveGui(cmd: GuiCommandArgs, lease: FileLockHandle): Promise<void> {
	let server: GuiServer;
	try {
		// Any address published now is a dead predecessor's: drop it, so a waiting `omp gui` never names its pid.
		await retractGui();
		await removeStaleGuiTemps();
		server = await startGuiServer({ port: cmd.port, token: await loadGuiToken(), rosterDir: guiHostedDir() });
	} catch (err) {
		lease.release();
		throw err;
	}
	const runtime: GuiRuntime = { pid: process.pid, port: server.port, token: server.token, url: server.url };
	await publishGui(runtime);
	announce(runtime, cmd.json, false);
	if (cmd.open) openPath(server.url);
	if (!cmd.json) process.stdout.write(`Press ${formatKeyHint("ctrl+c")} to stop; that ends its sessions too.\n`);

	let stopped: Promise<void> | undefined;
	// The lease is held through the whole stop: no other server starts while these sessions tear down.
	const stop = () => {
		stopped ??= (async () => {
			try {
				await server.stop();
				await retractGui();
			} finally {
				lease.release();
			}
		})();
		return stopped;
	};
	// postmortem runs this on SIGINT (Ctrl+C), SIGTERM and SIGHUP, with its other cleanups, then exits.
	postmortem.register("gui-server", stop);
	if (cmd.exitOnStdinClose) {
		// The parent holds the only write end and never writes: EOF (or a read error) means it is gone.
		void (async () => {
			try {
				for await (const _ of Bun.stdin.stream()) {
				}
			} catch {}
			await postmortem.quit(0, { drainStdout: false });
		})();
	}
	await Promise.withResolvers<void>().promise;
}
