/**
 * Local peer registry: every omp process that hosts top-level sessions
 * publishes one entry so sessions started separately on this machine (a TUI
 * in Ghostty, a GUI pane, a print run) can find and message each other.
 *
 * Same recipe as the Collab host registry (`collab/registry.ts`): an
 * owner-only directory under `~/.omp/run/peers`, metadata written
 * tmp-then-rename with a per-publication bearer token, and a native line
 * IPC endpoint (owner-only socket, peer uid checked natively). Requests are
 * one per connection: `snapshot` lists the process's sessions, `deliver`
 * hands one message to a local agent. Listers prune entries whose endpoint is
 * gone.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, isEnoent, isFsError } from "@oh-my-pi/pi-utils";

export const PEER_REGISTRY_VERSION = 1;
/** A message body plus envelope; larger requests close the connection natively. */
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ENTRY_ID_PATTERN = /^[a-f0-9]{16}$/;

/** How a process hosts its sessions; decides whether a message may start a turn. */
export type PeerMode = "tui" | "rpc" | "acp" | "print";

/** One top-level session a process offers to its peers. */
export interface PeerSessionInfo {
	sessionId: string;
	/** Short address (`agent://Main@<short>`): the last 8 hex digits of the session id. */
	short: string;
	/** IRC id of the session's main agent in its process (`Main`, or `acp:<id>`). */
	agentId: string;
	name: string | null;
	cwd: string;
	mode: PeerMode;
	busy: boolean;
	model: string | null;
	/** Whether a message to this session is delivered; ACP sessions only list themselves. */
	accepts: boolean;
}

export interface PeerSnapshot {
	instanceId: string;
	pid: number;
	sessions: PeerSessionInfo[];
}

/** Delivery request: `from` is the sender's qualified address (`<agent>@<short>`). */
export interface PeerDeliverRequest {
	to: { sessionId: string; agent: string };
	from: string;
	body: string;
	replyTo?: string;
}

export interface PeerDeliverReceipt {
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

/** What a published process answers with. */
export interface PeerSource {
	snapshot(): PeerSnapshot;
	deliver(request: PeerDeliverRequest): Promise<PeerDeliverReceipt>;
}

export interface PeerPublication {
	readonly endpoint: string;
	close(): Promise<void>;
}

interface PeerMetadata {
	version: number;
	entryId: string;
	pid: number;
	endpoint: string;
	createdAt: number;
	token: string;
}

export function peersRuntimeDir(): string {
	return path.join(getBaseConfigRoot(), "run", "peers");
}

/** `agent://Main@<short>` addresses a session by the tail of its id (UUIDv7 heads are timestamps and collide). */
export function shortSessionId(sessionId: string): string {
	return sessionId.replaceAll("-", "").slice(-8).toLowerCase();
}

function tokenMatches(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseMetadata(text: string): PeerMetadata | null {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (raw.version !== PEER_REGISTRY_VERSION) return null;
		if (typeof raw.entryId !== "string" || !ENTRY_ID_PATTERN.test(raw.entryId)) return null;
		if (typeof raw.pid !== "number" || typeof raw.endpoint !== "string" || typeof raw.token !== "string") return null;
		if (typeof raw.createdAt !== "number") return null;
		return raw as unknown as PeerMetadata;
	} catch {
		return null;
	}
}

function parseDeliver(raw: Record<string, unknown>): PeerDeliverRequest | null {
	const to = raw.to as Record<string, unknown> | undefined;
	if (!to || typeof to.sessionId !== "string" || typeof to.agent !== "string") return null;
	if (typeof raw.from !== "string" || !raw.from.includes("@")) return null;
	if (typeof raw.body !== "string" || raw.body.trim().length === 0) return null;
	if (raw.replyTo !== undefined && typeof raw.replyTo !== "string") return null;
	return { to: { sessionId: to.sessionId, agent: to.agent }, from: raw.from, body: raw.body, replyTo: raw.replyTo };
}

/** One request per connection: authenticate, dispatch, respond, close. */
function handleConnection(connection: IpcConnection, token: string, source: PeerSource, onClose: () => void): void {
	let handled = false;
	const respond = (payload: object): void => {
		handled = true;
		connection.send(JSON.stringify({ v: PEER_REGISTRY_VERSION, ...payload }));
		connection.end();
	};
	connection.start(line => {
		if (handled) return;
		let request: Record<string, unknown>;
		try {
			request = JSON.parse(line.trim());
		} catch {
			respond({ ok: false, error: "malformed_request" });
			return;
		}
		if (request.v !== PEER_REGISTRY_VERSION) return respond({ ok: false, error: "unsupported_protocol" });
		if (!tokenMatches(token, request.token)) return respond({ ok: false, error: "authentication_failed" });
		if (request.op === "snapshot") return respond({ ok: true, snapshot: source.snapshot() });
		if (request.op !== "deliver") return respond({ ok: false, error: "invalid_operation" });
		const deliver = parseDeliver(request);
		if (!deliver) return respond({ ok: false, error: "malformed_request" });
		handled = true;
		source.deliver(deliver).then(
			receipt => respond({ ok: true, receipt }),
			(error: unknown) => respond({ ok: true, receipt: { outcome: "failed", error: String(error) } }),
		);
	}, onClose);
}

async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`peer registry path is not a directory: ${dir}`);
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid)
		throw new Error(`peer registry directory is not owned by the current user: ${dir}`);
	if ((stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

function endpointFiles(endpoint: string): string[] {
	return process.platform === "win32" ? [] : [endpoint, `${endpoint}.bind.lock`];
}

function removeFilesSync(files: string[]): void {
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch {}
	}
}

/** Publish this process's sessions; `close()` on every teardown path (an exit hook covers normal exits). */
export async function publishPeer(source: PeerSource, options?: { dir?: string }): Promise<PeerPublication> {
	const dir = options?.dir ?? peersRuntimeDir();
	await ensurePrivateDir(dir);
	const entryId = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(32).toString("hex");
	const endpoint = ipcEndpoint(dir, entryId);
	const metaPath = path.join(dir, `${entryId}.json`);
	const tmpPath = `${metaPath}.tmp`;
	// Armed before the first file exists: a process that exits mid-publish leaves nothing behind.
	const removeOnExit = (): void => removeFilesSync([metaPath, tmpPath, ...endpointFiles(endpoint)]);
	process.once("exit", removeOnExit);
	const live = new Set<IpcConnection>();
	const server = await IpcServer.listen(
		endpoint,
		{ framing: "lines", maxFrameBytes: MAX_REQUEST_BYTES },
		connection => {
			live.add(connection);
			handleConnection(connection, token, source, () => live.delete(connection));
		},
	);
	try {
		const meta: PeerMetadata = {
			version: PEER_REGISTRY_VERSION,
			entryId,
			pid: process.pid,
			endpoint,
			createdAt: Date.now(),
			token,
		};
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(meta), "utf8");
		} finally {
			await handle.close();
		}
		await fs.promises.rename(tmpPath, metaPath);
	} catch (error) {
		process.off("exit", removeOnExit);
		await server.close();
		removeFilesSync([tmpPath, ...endpointFiles(endpoint)]);
		throw error;
	}
	let closed = false;
	return {
		endpoint,
		async close() {
			if (closed) return;
			closed = true;
			process.off("exit", removeOnExit);
			for (const connection of live) connection.destroy();
			removeFilesSync([metaPath]);
			await server.close();
			removeFilesSync(endpointFiles(endpoint));
		},
	};
}

type QueryResult =
	| { status: "ok"; value: Record<string, unknown> }
	| { status: "dead" }
	| { status: "skip"; error?: string };

function query(meta: PeerMetadata, request: object, timeoutMs: number): Promise<QueryResult> {
	const { promise, resolve } = Promise.withResolvers<QueryResult>();
	let connection: IpcConnection | undefined;
	let settled = false;
	const finish = (result: QueryResult): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		connection?.destroy();
		resolve(result);
	};
	const timer = setTimeout(() => finish({ status: "skip", error: "timeout" }), timeoutMs);
	IpcConnection.connect(meta.endpoint, { framing: "lines", timeoutMs, maxFrameBytes: MAX_RESPONSE_BYTES }).then(
		conn => {
			if (settled) {
				conn.destroy();
				return;
			}
			connection = conn;
			conn.start(
				line => {
					try {
						const response = JSON.parse(line) as Record<string, unknown>;
						if (response.ok === true) finish({ status: "ok", value: response });
						else
							finish({ status: "skip", error: typeof response.error === "string" ? response.error : undefined });
					} catch {
						finish({ status: "skip" });
					}
				},
				() => finish({ status: "skip" }),
			);
			conn.send(JSON.stringify({ v: PEER_REGISTRY_VERSION, token: meta.token, ...request }));
		},
		(error: unknown) => {
			// Only a refused or missing socket proves the process is gone.
			const code = isFsError(error) ? error.code : undefined;
			finish({ status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip" });
		},
	);
	return promise;
}

/** A publication this old that never renamed its metadata into place belongs to a process that died mid-publish. */
const ABANDONED_PUBLICATION_MS = 60_000;

/** Remove `<entry>.json.tmp` leftovers and their in-directory sockets once they are clearly abandoned. */
async function pruneAbandonedPublications(dir: string, entries: string[]): Promise<void> {
	const now = Date.now();
	for (const name of entries) {
		if (!name.endsWith(".json.tmp")) continue;
		const entryId = name.slice(0, -".json.tmp".length);
		if (!ENTRY_ID_PATTERN.test(entryId)) continue;
		const file = path.join(dir, name);
		const stat = await fs.promises.stat(file).catch(() => null);
		if (!stat || now - stat.mtimeMs < ABANDONED_PUBLICATION_MS) continue;
		const endpoint = ipcEndpoint(dir, entryId);
		const owned = endpoint.startsWith(dir + path.sep) ? endpointFiles(endpoint) : [];
		for (const leftover of [file, ...owned]) await fs.promises.rm(leftover, { force: true }).catch(() => {});
	}
}

export interface LivePeer {
	meta: PeerMetadata;
	snapshot: PeerSnapshot;
}

/** Every reachable peer process with its sessions; dead entries are pruned on the way. */
export async function listPeers(options?: { dir?: string; timeoutMs?: number }): Promise<LivePeer[]> {
	const dir = options?.dir ?? peersRuntimeDir();
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	await pruneAbandonedPublications(dir, entries);
	const names = entries.filter(name => name.endsWith(".json"));
	const results = await Promise.all(
		names.map(async name => {
			const file = path.join(dir, name);
			const meta = parseMetadata(await fs.promises.readFile(file, "utf8").catch(() => ""));
			if (!meta) return null;
			const result = await query(meta, { op: "snapshot" }, options?.timeoutMs ?? 1500);
			if (result.status === "dead") {
				await fs.promises.rm(file, { force: true }).catch(() => {});
				if (meta.endpoint.startsWith(dir + path.sep))
					for (const extra of endpointFiles(meta.endpoint))
						await fs.promises.rm(extra, { force: true }).catch(() => {});
				return null;
			}
			if (result.status !== "ok") return null;
			return { meta, snapshot: result.value.snapshot as PeerSnapshot };
		}),
	);
	return results.filter((peer): peer is LivePeer => peer !== null);
}

/** Hand one message to a session another process hosts. */
export async function deliverToPeer(
	peer: LivePeer,
	request: PeerDeliverRequest,
	timeoutMs = 5000,
): Promise<PeerDeliverReceipt> {
	const result = await query(peer.meta, { op: "deliver", ...request }, timeoutMs);
	if (result.status === "ok") return result.value.receipt as PeerDeliverReceipt;
	return {
		outcome: "failed",
		error: result.status === "dead" ? "that session's process has exited" : (result.error ?? "no answer"),
	};
}
