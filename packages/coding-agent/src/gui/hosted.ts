/**
 * The GUI server's roster of hosted sessions: one owner-only file per session
 * (`<runtime dir>/hosted/<guiId>.json`), written before the server starts the
 * session's omp, then rewritten with that process's identity and whenever the
 * server learns or changes its session file. A server stop, a crash or a
 * session that crashed leaves the file, so the next server offers the session
 * for restore; ending, dismissing or restoring it, or omp exiting cleanly by
 * itself, removes it. Ending marks it first (`ending`), before omp gets a
 * signal, and removes it once omp has exited, so neither a server that dies
 * while omp stops nor an omp that outlives the stop is ever offered again.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { syncDirectory, writeFileAtomically } from "../utils/atomic-file";

/** How a process exited: its code, or the signal that killed it. */
export interface ExitStatus {
	code: number | null;
	signal: string | null;
}

export interface HostedEntry {
	guiId: string;
	cwd: string;
	startedAt: number;
	/**
	 * The session's omp, once spawned. The entry is written before the spawn and again as soon as the
	 * spawn returns, with this pid; only a crash during that second write leaves an omp without one.
	 */
	pid?: number;
	/**
	 * The start time of `pid` (`processStartToken` in utils/process-identity.ts): a live `pid` with the
	 * same token is still this session's omp, outliving the server that hosted it, whether or not it
	 * answers anything. A live `pid` without one may be that omp or a process that reused its pid:
	 * nothing can tell which.
	 */
	startToken?: string;
	/** The omp session file, once known: the resume path at spawn, then what omp reports. */
	sessionFile?: string;
	/**
	 * The first message of a new session, so one that died before writing anything can start again.
	 * Only the session omp started with has it: it is cleared once the session file changes (/new, /resume).
	 */
	prompt?: string;
	/** The model a new session was started on, for starting its first message again. */
	model?: string;
	/** The `--thinking` level a new session was started with, for the same. */
	thinking?: string;
	/**
	 * The session's work-detail mode: the `--work-detail` it was started with, then each mode its composer
	 * chip shows once the user switches it there. omp's session file does not keep it, so a restore of this
	 * entry starts in it whatever mode the page sends; it outlives /new and /resume.
	 */
	workDetail?: string;
	/**
	 * The `--approval-mode` the session was started with, absent when it took `tools.approvalMode`. A restore
	 * of this entry starts in it whatever mode the page sends, as with `workDetail`.
	 */
	approvalMode?: string;
	/**
	 * The `--preset` the session was started with, "" for `--no-preset`; absent when it took the `agentPreset`
	 * setting. A restore of this entry starts from it, as with `approvalMode`.
	 */
	preset?: string;
	/** A no-project chat, which runs in its own directory under the chats dir. */
	chat: boolean;
	/** How omp exited when it ended by itself and not cleanly (a crash, a signal from elsewhere). */
	exit?: ExitStatus;
	/**
	 * The entry this one restored. A crash between writing this entry and removing that one leaves
	 * both; the next server drops the restored one, so it is never started twice.
	 */
	restoredFrom?: string;
	/**
	 * The user ended it (End session, or End of a session that outlived its server), recorded before the
	 * first signal; the entry goes once omp has exited. A server that dies during the stop, or an omp that
	 * outlives it, leaves the entry: no server offers it for restore, and the next one lists it as still
	 * running while its omp may run, so End can be tried again, and drops it once that omp is gone.
	 */
	ending?: boolean;
}

/** GUI ids are minted by the server; anything else never names a roster file. */
const GUI_ID = /^[0-9a-f]{8}$/;

function isGuiId(value: unknown): value is string {
	return typeof value === "string" && GUI_ID.test(value);
}

function optional(value: unknown, type: "string" | "number"): boolean {
	return value === undefined || typeof value === type;
}

function parseExit(value: unknown): ExitStatus | undefined | null {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") return null;
	const { code, signal } = value as Record<string, unknown>;
	if ((code !== null && typeof code !== "number") || (signal !== null && typeof signal !== "string")) return null;
	return { code, signal };
}

function parseEntry(text: string, guiId: string): HostedEntry | undefined {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Record<string, unknown>;
	if (entry.guiId !== guiId || typeof entry.cwd !== "string") return undefined;
	if (typeof entry.startedAt !== "number" || typeof entry.chat !== "boolean") return undefined;
	if (!optional(entry.pid, "number") || !optional(entry.startToken, "string")) return undefined;
	if (!optional(entry.sessionFile, "string") || !optional(entry.prompt, "string")) return undefined;
	if (!optional(entry.model, "string") || !optional(entry.thinking, "string")) return undefined;
	if (!optional(entry.workDetail, "string") || !optional(entry.approvalMode, "string")) return undefined;
	if (!optional(entry.preset, "string")) return undefined;
	if (entry.ending !== undefined && entry.ending !== true) return undefined;
	if (entry.restoredFrom !== undefined && !isGuiId(entry.restoredFrom)) return undefined;
	const exit = parseExit(entry.exit);
	if (exit === null) return undefined;
	return {
		guiId,
		cwd: entry.cwd,
		startedAt: entry.startedAt,
		pid: entry.pid as number | undefined,
		startToken: entry.startToken as string | undefined,
		sessionFile: entry.sessionFile as string | undefined,
		prompt: entry.prompt as string | undefined,
		model: entry.model as string | undefined,
		thinking: entry.thinking as string | undefined,
		workDetail: entry.workDetail as string | undefined,
		approvalMode: entry.approvalMode as string | undefined,
		preset: entry.preset as string | undefined,
		chat: entry.chat,
		exit,
		restoredFrom: entry.restoredFrom,
		ending: entry.ending,
	};
}

/**
 * Record a session file omp reported for the entry's session. A different file than the one known
 * (after /new, /resume or a cwd switch) is another session, so the first message no longer belongs
 * to it: a restore must continue that file, never replay the first session's task.
 */
export function learnSessionFile(entry: HostedEntry, file: string): void {
	if (entry.sessionFile !== undefined && entry.sessionFile !== file) {
		entry.prompt = undefined;
		entry.model = undefined;
		entry.thinking = undefined;
	}
	entry.sessionFile = file;
}

export class HostedRoster {
	readonly #dir: string;
	/** Per-entry write chains: a later write or removal never lands before an earlier one. */
	readonly #pending = new Map<string, Promise<void>>();

	constructor(dir: string) {
		this.#dir = dir;
	}

	/** Every readable entry. A file that does not parse is logged and moved aside as `<name>.bad`. */
	async read(): Promise<HostedEntry[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.#dir);
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
		const entries: HostedEntry[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(this.#dir, name);
			let entry: HostedEntry | undefined;
			let error: unknown;
			try {
				entry = parseEntry(await Bun.file(file).text(), name.slice(0, -".json".length));
			} catch (err) {
				if (isEnoent(err)) continue;
				error = err;
			}
			if (entry) {
				entries.push(entry);
				continue;
			}
			logger.warn("gui: moving aside a hosted-session entry that does not parse", {
				file,
				error: error === undefined ? "not a hosted-session entry" : String(error),
			});
			await fs.rename(file, `${file}.bad`).catch(err => {
				logger.warn("gui: could not move aside a bad hosted-session entry", { file, error: String(err) });
			});
		}
		return entries;
	}

	write(entry: HostedEntry): Promise<void> {
		const text = JSON.stringify(entry);
		return this.#enqueue(entry.guiId, async () => {
			// Every time: a failed or removed directory must not cost every later write.
			const created = await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
			// A directory made just now is flushed into its parent, or a crash could take it with the entry inside.
			if (created !== undefined) await syncDirectory(path.dirname(this.#dir));
			await writeFileAtomically(this.#file(entry.guiId), text);
		});
	}

	remove(guiId: string): Promise<void> {
		return this.#enqueue(guiId, async () => {
			await fs.rm(this.#file(guiId), { force: true });
			// Flushed like a write, so a system crash (on Linux, a power loss too; see syncDirectory) cannot
			// bring back a session that was ended or dismissed.
			await syncDirectory(this.#dir);
		});
	}

	/** Wait until no write or removal is pending, including ones issued while waiting. */
	async flush(): Promise<void> {
		while (this.#pending.size > 0) await Promise.allSettled(this.#pending.values());
	}

	#file(guiId: string): string {
		if (!isGuiId(guiId)) throw new Error(`not a GUI session id: ${guiId}`);
		return path.join(this.#dir, `${guiId}.json`);
	}

	#enqueue(guiId: string, task: () => Promise<void>): Promise<void> {
		const next = (this.#pending.get(guiId) ?? Promise.resolve()).catch(() => {}).then(task);
		this.#pending.set(guiId, next);
		const settle = () => {
			if (this.#pending.get(guiId) === next) this.#pending.delete(guiId);
		};
		next.then(settle, settle);
		return next;
	}
}
