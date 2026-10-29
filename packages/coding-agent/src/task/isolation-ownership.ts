/**
 * Ownership marker for task-isolation sandboxes under `~/.omp/wt/`.
 *
 * Each isolation base dir (`ensureIsolation` in {@link ./worktree}) holds a
 * compact `m` mount plus this marker file naming the omp process that created
 * it. `omp worktree clear` consults the marker so it can distinguish a live
 * subagent's sandbox from a crashed run's leftover instead of deleting both.
 */
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { $ } from "bun";
import { processStartToken } from "../utils/process-identity";

const { IsoBackendKind } = natives;

/** Marker file written into a task-isolation base dir identifying its owner. */
export const ISOLATION_OWNER_FILE = ".omp-isolation-owner.json";

/** Recorded owner of a task-isolation sandbox. */
export interface IsolationOwner {
	/** PID of the omp process that created and owns the sandbox. */
	pid: number;
	/** Task id the sandbox was materialised for. */
	id: string;
	/**
	 * Process-instance start-time token for {@link pid} ({@link processStartToken}),
	 * when the OS can report it. Distinguishes the owning process from an unrelated
	 * process that later inherits a recycled pid, so a crashed sandbox is never
	 * pinned live.
	 */
	startToken?: string;
	/**
	 * How {@link startToken} was made: {@link START_TOKEN_FORMAT} for {@link processStartToken}.
	 * Absent on markers older omps wrote; off Linux their token is {@link legacyStartToken}'s.
	 */
	startTokenFormat?: number;
}

/** The {@link IsolationOwner.startTokenFormat} of a token {@link processStartToken} made. */
const START_TOKEN_FORMAT = 2;

/**
 * The start-time token isolation markers carried before {@link processStartToken} pinned `ps` to the
 * C locale and UTC: `ps -o lstart` in the caller's own locale and time zone, or null where that format
 * never differed (Linux always read `/proc`) or `ps` gives nothing. A marker without a
 * {@link IsolationOwner.startTokenFormat} carries this format; matching it keeps the sandbox of an
 * older omp that is still running alive.
 *
 * Remove it, with its use in {@link hasLiveIsolationOwner}, once no running omp predates this build:
 * a marker without a `startTokenFormat` whose pid is still alive belongs to one that does.
 */
async function legacyStartToken(pid: number): Promise<string | null> {
	if (process.platform === "linux" || process.platform === "win32") return null;
	const res = await $`ps -o lstart= -p ${pid}`.quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
}

/**
 * Record the current process as owner of the sandbox rooted at `baseDir`.
 *
 * Written before the isolation backend materialises `m` so a concurrent
 * `omp worktree clear` never sees an owner-less sandbox mid-creation.
 */
export async function writeIsolationOwner(baseDir: string, id: string): Promise<void> {
	const startToken = await processStartToken(process.pid);
	const owner: IsolationOwner = {
		pid: process.pid,
		id,
		...(startToken ? { startToken, startTokenFormat: START_TOKEN_FORMAT } : {}),
	};
	await Bun.write(path.join(baseDir, ISOLATION_OWNER_FILE), JSON.stringify(owner));
}

/**
 * Whether a live omp process still owns the sandbox at `baseDir`.
 *
 * A missing or malformed marker means no verifiable owner — a crashed run or a
 * sandbox from before markers existed, both safe to reclaim. `process.kill(pid,
 * 0)` can fail with `EPERM` even when the process is alive, so only an explicit
 * `ESRCH` ("no such process") counts as dead; any other error is treated as
 * alive to avoid deleting a sandbox that is actually in use. When the marker
 * carries a {@link IsolationOwner.startToken}, a live pid whose current token no
 * longer matches is a recycled pid — a different process — and counts as dead;
 * a token in a format this build does not know cannot be checked, so its live
 * pid counts.
 */
export async function hasLiveIsolationOwner(baseDir: string): Promise<boolean> {
	let decoded: unknown;
	try {
		decoded = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).json();
	} catch {
		return false;
	}
	if (typeof decoded !== "object" || decoded === null || !("pid" in decoded)) return false;
	const pid = decoded.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	// The pid is live (or unknowable via EPERM). Reject a recycled pid: if the
	// marker pinned the owner's start-time token, the process wearing that pid
	// now must still present the same token, in the format the marker names. A
	// marker naming none is an older omp's: its token is in the legacy format,
	// unless it came from /proc (Linux), where both formats are the same.
	if ("startToken" in decoded && typeof decoded.startToken === "string" && decoded.startToken.length > 0) {
		const recorded = decoded.startToken;
		const format = "startTokenFormat" in decoded ? decoded.startTokenFormat : undefined;
		if (format !== undefined && format !== START_TOKEN_FORMAT) return true;
		const current = await processStartToken(pid);
		if (current === null || current === recorded) return true;
		return format === undefined && (await legacyStartToken(pid)) === recorded;
	}
	return true;
}

/** Sidecar recording the native-teardown backend of a retained workspace. */
export const RETAINED_BACKEND_FILE = ".omp-retained-backend.json";

/**
 * Backends whose workspaces `omp worktree clear` must not remove with plain
 * recursive `rm`, but route through native `isoStop` teardown instead:
 * mounts (overlayfs, projfs), where `rm` destroys the preserved layer and
 * fails on the mountpoint, and Btrfs subvolumes, whose root is only removable
 * via subvolume delete (its `stop` falls back to plain `rm` for ordinary
 * dirs, so routing it is always safe). Plain-copy and reflink backends need
 * no teardown — and their `stop` routines delete data themselves, so they
 * must never be routed through it.
 *
 * Notably absent: ZFS clones also need dataset-aware teardown, but `isoStop`
 * locates the dataset by its recorded mountpoint property, which no longer
 * matches after the retain rename — that needs pi-iso mount-table support
 * before a sidecar here could help.
 */
export function needsNativeTeardown(backend: unknown): backend is number {
	return backend === IsoBackendKind.Overlayfs || backend === IsoBackendKind.Projfs || backend === IsoBackendKind.Btrfs;
}

/**
 * Record which backend built a retained workspace, so cleanup can route it
 * through native teardown before removal. Best-effort: retention stays valid
 * without it (the workspace merely falls back to plain recursive removal).
 */
export async function writeRetainedBackend(baseDir: string, backend: number): Promise<void> {
	await Bun.write(
		path.join(baseDir, RETAINED_BACKEND_FILE),
		JSON.stringify({ backend, retainedAt: new Date().toISOString() }),
	);
}

/**
 * Backend recorded for a retained workspace when it needs native teardown
 * before remove. `undefined` only when no sidecar exists. Any other read
 * problem (permissions, I/O, malformed JSON) throws instead of reading as
 * absent: the workspace may be a live mount whose guard must not be silently
 * bypassed — the caller then leaves it in place rather than removing through
 * the mount. A well-formed record for a backend needing no teardown keeps
 * today's removal behavior.
 */
export async function readRetainedMountBackend(dir: string): Promise<number | undefined> {
	const sidecar = path.join(dir, RETAINED_BACKEND_FILE);
	if (!(await Bun.file(sidecar).exists())) return undefined;
	const decoded: unknown = await Bun.file(sidecar).json();
	if (typeof decoded !== "object" || decoded === null || !("backend" in decoded)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	const backend = decoded.backend;
	if (typeof backend !== "number" || !Number.isInteger(backend)) {
		throw new Error(`retained-mount metadata at ${sidecar} is malformed`);
	}
	if (!needsNativeTeardown(backend)) return undefined;
	return backend;
}
