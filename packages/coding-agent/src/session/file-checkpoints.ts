/**
 * File checkpoints: the prior state of every file omp's own file tools change,
 * recorded once per user turn so a rewind can restore code as well as the
 * conversation.
 *
 * Before `write`, `edit` (every mode), `ast_edit`, the `lsp` tool's workspace
 * edits or a `conflict://` resolution changes a file, the tool calls
 * {@link FileCheckpointRecorder.recordBefore}. The first call for a path in a
 * turn saves the file's bytes (or "did not exist") keyed by the user-request
 * entry that started the turn; later calls in the same turn are no-ops.
 * Subagents that edit the parent's checkout share the parent's recorder, so
 * their edits land in the parent's turn.
 *
 * Restoring to a user message rewinds every file changed by that turn or any
 * later turn in its subtree to the state it had before the earliest of those
 * changes: content is written back and files that did not exist are deleted.
 *
 * Storage lives in the session's artifacts directory, so it follows the session
 * through `/resume`, `/fork` and `/move`:
 *
 *   <artifacts>/file-checkpoints/manifest.json   records + turns removed by retention
 *   <artifacts>/file-checkpoints/blobs/<sha256>  content, deduplicated by hash
 *
 * Retention drops whole turns, oldest first, when they exceed the age limit or
 * the session's checkpoints exceed the size cap. A rewind whose range reaches
 * back to a dropped turn reports itself incomplete instead of restoring a
 * partial state.
 *
 * Not tracked: changes made by `bash`/`eval` commands, by editors or other
 * processes outside the session, and by subagents running in isolated
 * worktrees (their changes come back through the isolation merge).
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { BlobStore } from "./blob-store";
import type { SessionEntry } from "./session-entries";

/** Directory under the session's artifacts directory that holds checkpoints. */
export const FILE_CHECKPOINTS_DIRNAME = "file-checkpoints";
/** Files larger than this are not snapshotted (generated bundles, datasets). */
export const FILE_CHECKPOINT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const MANIFEST_NAME = "manifest.json";
const MANIFEST_VERSION = 1;

/** Records a file's state before a tool changes it. Shared by a session and its non-isolated subagents. */
export interface FileCheckpointRecorder {
	recordBefore(absolutePath: string): Promise<void>;
}

/** One saved prior state: `hash` is null when the file did not exist. */
export interface FileCheckpointRecord {
	/** User-request entry id of the turn that first changed the file. */
	turn: string;
	path: string;
	hash: string | null;
	size: number;
	/** Permission bits of the file when it existed. */
	mode?: number;
	/** Epoch ms when the record was taken. */
	at: number;
}

interface Manifest {
	version: number;
	records: FileCheckpointRecord[];
	/** Turns whose records retention removed; a restore whose range includes one is incomplete. */
	prunedTurns: string[];
}

/** What restoring one file does to the working tree. */
export type FileRestoreAction = "modify" | "recreate" | "delete";

export interface FileRestoreChange {
	path: string;
	action: FileRestoreAction;
	record: FileCheckpointRecord;
}

export interface FileRestorePlan {
	targetEntryId: string;
	/** Files whose current state differs from the target point, sorted by path. */
	changes: FileRestoreChange[];
	/** False when retention removed checkpoints this range needs; the plan must not be applied. */
	complete: boolean;
}

export interface FileRestoreResult {
	restored: string[];
	failed: { path: string; error: string }[];
}

export interface FileCheckpointLimits {
	/** Cap on stored content bytes per session. */
	maxBytes: number;
	/** Turns whose first record is older than this are removed. */
	maxAgeMs: number;
	/** Files larger than this are not snapshotted. */
	maxFileBytes: number;
}

/** The parts of a SessionManager the store reads. */
export interface FileCheckpointHost {
	getArtifactsDir(): string | null;
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
}

export interface FileCheckpointStoreOptions {
	enabled: () => boolean;
	limits: () => FileCheckpointLimits;
	/** Called after a restore rewrote or deleted `path`, to drop caches keyed by its content. */
	onRestored?: (path: string) => void;
	now?: () => number;
}

interface DirState {
	dir: string;
	blobs: BlobStore;
	manifest: Manifest;
	/** `${turn}\0${path}` of every record, for the once-per-turn check. */
	keys: Set<string>;
	pending: Map<string, Promise<void>>;
	writeChain: Promise<void>;
}

function recordKey(turn: string, filePath: string): string {
	return `${turn}\0${filePath}`;
}

function sha256(data: Uint8Array): string {
	return new Bun.SHA256().update(data).digest("hex");
}

function emptyManifest(): Manifest {
	return { version: MANIFEST_VERSION, records: [], prunedTurns: [] };
}

function parseManifest(raw: unknown): Manifest {
	if (typeof raw !== "object" || raw === null) return emptyManifest();
	const value = raw as Partial<Manifest>;
	if (value.version !== MANIFEST_VERSION || !Array.isArray(value.records)) return emptyManifest();
	const records = value.records.filter(
		(record): record is FileCheckpointRecord =>
			typeof record === "object" &&
			record !== null &&
			typeof record.turn === "string" &&
			typeof record.path === "string" &&
			(record.hash === null || typeof record.hash === "string") &&
			typeof record.at === "number",
	);
	return {
		version: MANIFEST_VERSION,
		records,
		prunedTurns: Array.isArray(value.prunedTurns)
			? value.prunedTurns.filter((turn): turn is string => typeof turn === "string")
			: [],
	};
}

export class FileCheckpointStore implements FileCheckpointRecorder {
	readonly #host: FileCheckpointHost;
	readonly #options: FileCheckpointStoreOptions;
	#state: Promise<DirState> | undefined;
	#stateDir: string | undefined;

	constructor(host: FileCheckpointHost, options: FileCheckpointStoreOptions) {
		this.#host = host;
		this.#options = options;
	}

	/**
	 * Save `absolutePath`'s current state for the running turn unless this turn
	 * already did. Never throws: a failed snapshot is logged and the tool's
	 * write proceeds.
	 */
	async recordBefore(absolutePath: string): Promise<void> {
		try {
			if (!this.#options.enabled()) return;
			const turn = this.#currentTurn();
			if (!turn) return;
			const state = await this.#load();
			if (!state) return;
			const filePath = path.resolve(absolutePath);
			// Session-owned files (local:// plans, tool artifacts) are not project code.
			const artifactsDir = path.dirname(state.dir);
			if (filePath.startsWith(artifactsDir + path.sep)) return;
			const key = recordKey(turn, filePath);
			if (state.keys.has(key)) return;
			const pending = state.pending.get(key);
			if (pending) return await pending;
			const capture = this.#capture(state, turn, filePath).finally(() => state.pending.delete(key));
			state.pending.set(key, capture);
			await capture;
		} catch (error) {
			logger.warn("File checkpoint failed", {
				path: absolutePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Every record of the current session, oldest first. */
	async records(): Promise<readonly FileCheckpointRecord[]> {
		const state = await this.#load();
		return state ? state.manifest.records : [];
	}

	/**
	 * Files that restoring code to just before user-request entry `targetEntryId`
	 * would change, compared with what is on disk now.
	 */
	async planRestore(targetEntryId: string): Promise<FileRestorePlan> {
		const plan: FileRestorePlan = { targetEntryId, changes: [], complete: true };
		const state = await this.#load();
		if (!state) return plan;
		if (!this.#host.getEntry(targetEntryId)) return plan;

		const inScope = new Map<string, boolean>();
		const earliest = new Map<string, FileCheckpointRecord>();
		for (const record of state.manifest.records) {
			if (earliest.has(record.path)) continue;
			if (this.#inSubtree(record.turn, targetEntryId, inScope)) earliest.set(record.path, record);
		}
		// A dropped turn in range may have held a file's earliest prior state.
		if (state.manifest.prunedTurns.some(turn => this.#inSubtree(turn, targetEntryId, inScope))) {
			plan.complete = false;
		}

		for (const record of earliest.values()) {
			const action = await this.#diff(record);
			if (action) plan.changes.push({ path: record.path, action, record });
		}
		plan.changes.sort((a, b) => a.path.localeCompare(b.path));
		return plan;
	}

	/** Apply a plan from {@link planRestore}. Each file is restored independently; failures are reported, not thrown. */
	async applyRestore(plan: FileRestorePlan): Promise<FileRestoreResult> {
		const result: FileRestoreResult = { restored: [], failed: [] };
		if (!plan.complete) {
			throw new Error("File checkpoints for this point were removed by retention; code cannot be restored");
		}
		const state = await this.#load();
		if (!state) return result;
		for (const change of plan.changes) {
			try {
				if (change.action === "delete") {
					await fs.rm(change.path, { force: true });
				} else {
					const hash = change.record.hash;
					const data = hash === null ? null : await state.blobs.get(hash);
					if (!data) throw new Error("saved content is missing");
					await Bun.write(change.path, data);
					if (change.record.mode !== undefined) await fs.chmod(change.path, change.record.mode);
				}
				result.restored.push(change.path);
				this.#options.onRestored?.(change.path);
			} catch (error) {
				result.failed.push({ path: change.path, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return result;
	}

	/** User-request entry that started the running turn: the nearest one at or above the leaf. */
	#currentTurn(): string | null {
		let id = this.#host.getLeafId();
		while (id) {
			const entry = this.#host.getEntry(id);
			if (!entry) return null;
			if (isUserRequestEntry(entry)) return entry.id;
			id = entry.parentId;
		}
		return null;
	}

	#inSubtree(turn: string, rootId: string, memo: Map<string, boolean>): boolean {
		const cached = memo.get(turn);
		if (cached !== undefined) return cached;
		const visited: string[] = [];
		let id: string | null = turn;
		let found = false;
		while (id) {
			const known = memo.get(id);
			if (known !== undefined) {
				found = known;
				break;
			}
			visited.push(id);
			if (id === rootId) {
				found = true;
				break;
			}
			id = this.#host.getEntry(id)?.parentId ?? null;
		}
		for (const visitedId of visited) memo.set(visitedId, found);
		return found;
	}

	async #diff(record: FileCheckpointRecord): Promise<FileRestoreAction | undefined> {
		let stat: Stats | undefined;
		try {
			stat = await fs.stat(record.path);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (record.hash === null) return stat ? (stat.isFile() ? "delete" : undefined) : undefined;
		if (!stat) return "recreate";
		if (!stat.isFile()) return undefined;
		if (stat.size !== record.size) return "modify";
		const current = sha256(await fs.readFile(record.path));
		return current === record.hash ? undefined : "modify";
	}

	async #capture(state: DirState, turn: string, filePath: string): Promise<void> {
		let stat: Stats | undefined;
		try {
			stat = await fs.stat(filePath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		// Directories and special files are never written by the file tools.
		if (stat && !stat.isFile()) return;
		if (stat && stat.size > this.#options.limits().maxFileBytes) {
			logger.debug("File checkpoint skipped: file too large", { path: filePath, size: stat.size });
			return;
		}
		const record: FileCheckpointRecord = { turn, path: filePath, hash: null, size: 0, at: this.#now() };
		const data = stat ? await fs.readFile(filePath) : undefined;
		if (stat) record.mode = stat.mode & 0o7777;
		// The blob is stored inside the serialized section so retention cannot
		// delete a reused blob between this put and the record that references it.
		await this.#persist(state, turn, async () => {
			if (data) {
				record.hash = (await state.blobs.put(data)).hash;
				record.size = data.byteLength;
			}
			state.manifest.records.push(record);
			state.keys.add(recordKey(turn, filePath));
		});
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	async #load(): Promise<DirState | undefined> {
		const artifactsDir = this.#host.getArtifactsDir();
		if (!artifactsDir) return undefined;
		const dir = path.join(artifactsDir, FILE_CHECKPOINTS_DIRNAME);
		if (this.#state && this.#stateDir === dir) return this.#state;
		this.#stateDir = dir;
		this.#state = this.#open(dir);
		return this.#state;
	}

	async #open(dir: string): Promise<DirState> {
		let manifest: Manifest;
		try {
			manifest = parseManifest(await Bun.file(path.join(dir, MANIFEST_NAME)).json());
		} catch (error) {
			if (!isEnoent(error)) logger.warn("Unreadable file checkpoint manifest; starting fresh", { dir });
			manifest = emptyManifest();
		}
		const state: DirState = {
			dir,
			blobs: new BlobStore(path.join(dir, "blobs")),
			manifest,
			keys: new Set(manifest.records.map(record => recordKey(record.turn, record.path))),
			pending: new Map(),
			writeChain: Promise.resolve(),
		};
		if (manifest.records.length > 0) await this.#persist(state, undefined);
		return state;
	}

	/** Run `mutate`, apply retention, then write the manifest. Serialized per directory. */
	#persist(state: DirState, currentTurn: string | undefined, mutate?: () => Promise<void>): Promise<void> {
		const run = async () => {
			await mutate?.();
			const removedHashes = this.#prune(state, currentTurn);
			const manifestPath = path.join(state.dir, MANIFEST_NAME);
			const staging = `${manifestPath}.${process.pid}.tmp`;
			await Bun.write(staging, JSON.stringify(state.manifest));
			await fs.rename(staging, manifestPath);
			for (const hash of removedHashes) {
				await fs.rm(path.join(state.blobs.dir, hash), { force: true });
			}
		};
		const next = state.writeChain.then(run, run);
		state.writeChain = next.catch(() => {});
		return next;
	}

	/**
	 * Drop whole turns, oldest first: every turn older than the age limit, then
	 * more until stored content fits the size cap. The running turn is kept.
	 * Returns blob hashes no remaining record references.
	 */
	#prune(state: DirState, currentTurn: string | undefined): string[] {
		const { maxBytes, maxAgeMs } = this.#options.limits();
		const records = state.manifest.records;
		const turnStart = new Map<string, number>();
		for (const record of records) {
			if (!turnStart.has(record.turn)) turnStart.set(record.turn, record.at);
		}
		const turns = [...turnStart.keys()].sort((a, b) => turnStart.get(a)! - turnStart.get(b)!);

		const blobSizes = new Map<string, number>();
		const blobRefs = new Map<string, number>();
		for (const record of records) {
			if (record.hash === null) continue;
			blobSizes.set(record.hash, record.size);
			blobRefs.set(record.hash, (blobRefs.get(record.hash) ?? 0) + 1);
		}
		let total = 0;
		for (const size of blobSizes.values()) total += size;

		const cutoff = this.#now() - maxAgeMs;
		const dropped = new Set<string>();
		for (const turn of turns) {
			if (turn === currentTurn) break;
			const expired = turnStart.get(turn)! < cutoff;
			if (!expired && total <= maxBytes) break;
			dropped.add(turn);
			for (const record of records) {
				if (record.turn !== turn || record.hash === null) continue;
				const refs = blobRefs.get(record.hash)! - 1;
				blobRefs.set(record.hash, refs);
				if (refs === 0) total -= record.size;
			}
		}
		if (dropped.size === 0) return [];

		state.manifest.prunedTurns.push(...dropped);
		state.manifest.records = records.filter(record => !dropped.has(record.turn));
		state.keys = new Set(state.manifest.records.map(record => recordKey(record.turn, record.path)));
		const removed: string[] = [];
		for (const [hash, refs] of blobRefs) if (refs === 0) removed.push(hash);
		return removed;
	}
}
