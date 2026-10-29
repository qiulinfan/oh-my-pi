/**
 * One `omp gui` server per runtime directory (`getGuiRuntimeDir()`, normally
 * ~/.omp/run/gui). The process that serves holds a kernel lease on
 * server.json for its whole life and publishes its address there (owner-only);
 * every later `omp gui` (or the desktop app) attaches to that server instead
 * of starting another, so the browser and the desktop window show the same
 * live sessions. The directory also keeps the machine token and the roster of
 * hosted sessions.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FileLockHandle, getGuiRuntimeDir, isEexist, isEnoent, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { syncDirectory, writeFileAtomically } from "../utils/atomic-file";

export interface GuiRuntime {
	pid: number;
	port: number;
	token: string;
	url: string;
}

/** What `/api/ping` answers. */
export interface GuiPing {
	pid: number;
	bootId: string;
	version: string;
	/** The omp executable this server runs from has been replaced on disk since it started. */
	replaced: boolean;
	stopping: boolean;
}

/** The published server as a ping finds it: answering, stopping (503), or not answering (or none published). */
export type GuiProbe =
	| { state: "up"; runtime: GuiRuntime; ping: GuiPing }
	| { state: "stopping"; runtime: GuiRuntime }
	| { state: "down"; runtime: GuiRuntime | null };

const TOKEN = /^[0-9a-f]{32}$/;
/** A temp file this old is a leftover of a process that died mid-write. */
const STALE_TEMP_MS = 60_000;

function runtimeFile(): string {
	return path.join(getGuiRuntimeDir(), "server.json");
}

/** Where the server keeps one file per hosted session. */
export function guiHostedDir(): string {
	return path.join(getGuiRuntimeDir(), "hosted");
}

/**
 * Take the server lease, or null while another process holds it. The lease is
 * process-owned: the kernel drops it on any death, and the holder keeps the
 * handle referenced until it has retracted server.json.
 */
export async function acquireGuiLease(): Promise<FileLockHandle | null> {
	await fs.mkdir(getGuiRuntimeDir(), { recursive: true, mode: 0o700 });
	return tryAcquireFileLock(runtimeFile());
}

/** The published address, or null when none is (or it is torn). */
export async function readRuntime(): Promise<GuiRuntime | null> {
	try {
		return (await Bun.file(runtimeFile()).json()) as GuiRuntime;
	} catch (err) {
		if (isEnoent(err) || err instanceof SyntaxError) return null;
		throw err;
	}
}

/** Ping the published server with its token. */
export async function probeGui(): Promise<GuiProbe> {
	const runtime = await readRuntime();
	if (!runtime) return { state: "down", runtime: null };
	try {
		const response = await fetch(`http://127.0.0.1:${runtime.port}/api/ping`, {
			headers: { "x-omp-gui-token": runtime.token },
			signal: AbortSignal.timeout(1500),
		});
		const ping = (await response.json()) as GuiPing;
		if (response.ok) return { state: "up", runtime, ping };
		if (response.status === 503 && ping.stopping) return { state: "stopping", runtime };
	} catch {}
	return { state: "down", runtime };
}

/** Publish this server's address; only the lease holder calls it. */
export async function publishGui(runtime: GuiRuntime): Promise<void> {
	await writeFileAtomically(runtimeFile(), JSON.stringify(runtime));
}

/** Remove the published address; only the lease holder calls it: at start (a dead predecessor's), and before releasing the lease. */
export async function retractGui(): Promise<void> {
	await fs.rm(runtimeFile(), { force: true });
}

/**
 * Remove `*.tmp` files a process left behind when it died mid-write (they can
 * hold the token). Run by the lease holder at start.
 */
export async function removeStaleGuiTemps(): Promise<void> {
	const cutoff = Date.now() - STALE_TEMP_MS;
	for (const dir of [getGuiRuntimeDir(), guiHostedDir()]) {
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		for (const name of names) {
			if (!name.endsWith(".tmp")) continue;
			const file = path.join(dir, name);
			const stat = await fs.stat(file).catch(() => null);
			if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true });
		}
	}
}

async function readToken(file: string): Promise<string | null> {
	try {
		const token = (await Bun.file(file).text()).trim();
		return TOKEN.test(token) ? token : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/**
 * The machine token every request to the GUI server carries, kept at
 * `<runtime dir>/token` so pages and the desktop app stay valid across server
 * restarts; deleting the file rotates it on the next start. A missing or
 * malformed token is minted anew and published with a hard link, which never
 * replaces a file, so concurrent starters agree on the winner's. Called by the
 * lease holder.
 */
export async function loadGuiToken(): Promise<string> {
	const dir = getGuiRuntimeDir();
	const file = path.join(dir, "token");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 3; attempt++) {
		const existing = await readToken(file);
		if (existing) return existing;
		// Malformed (an empty or truncated file): clear it so the link below can publish.
		await fs.rm(file, { force: true });
		const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
		const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			const handle = await fs.open(temp, "wx", 0o600);
			try {
				await handle.writeFile(token, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.chmod(temp, 0o600);
			await fs.link(temp, file);
		} catch (err) {
			if (!isEexist(err)) throw err;
			continue;
		} finally {
			await fs.rm(temp, { force: true });
		}
		// Flushed, so a crash cannot take back a token pages and the desktop app already carry.
		await syncDirectory(dir);
		return token;
	}
	throw new Error(`could not read or create the GUI token at ${file}`);
}
