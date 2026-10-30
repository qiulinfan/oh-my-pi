/**
 * The app shell, laid out like Claude Code's desktop app: a session sidebar
 * (the sessions this server hosts, saved sessions grouped by project and the
 * no-project chats, other omp sessions on this Mac) and one session at a time
 * beside it, under a header naming it. "New session" opens a start page whose
 * first message becomes omp's positional prompt; it runs in the chosen
 * project, or as a chat in its own empty directory. Keys typed outside the composer go to omp as pty
 * bytes, so every omp shortcut (Ctrl+S agent hub, Shift+Tab effort, Esc)
 * works as in a terminal; F6 alone stays here, moving focus between the
 * prompt and the transcript's row heads.
 */
import {
	Fragment,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { ApiError, api, errorText, link, type ServerIdentity } from "./api";
import { Icon } from "./icons";
import { keyBytes } from "./keys";
import {
	type Choice,
	ChoicePicker,
	EffortPicker,
	findModel,
	type ModelList,
	ModelListContext,
	ModelPicker,
	thinkingFor,
	useDismiss,
} from "./pickers";
import { pinProject, usePinnedProjects, usePref } from "./prefs";
import {
	N,
	OmpMark,
	PrefsActionContext,
	PrefsExtraContext,
	SurfaceContext,
	type SurfaceContextValue,
	Transcript,
	toggleTranscriptFocus,
} from "./render";
import { type ExitInfo, SessionConnection, type SessionInfo, type SurfaceMeta } from "./session";
import type { SurfaceStore } from "./store";

/** The transcript column (see --column): omp lays its rows out for this width, not the window's. */
const COLUMN_PX = 760;
/** Dismisses an interrupted entry, or a live session that has exited: it leaves the list and the roster. */
const DISMISS_PATH = "/api/interrupted/dismiss";
/** How long a resume or restore runs before the page says it is waiting for the previous omp. */
const WAITING_MS = 1000;
/** The desktop app adds `env=degraded` when it could not read the login shell's environment. */
const DEGRADED_ENV = new URLSearchParams(location.search).get("env") === "degraded";
/**
 * The folder an editor that frames this page has open (its `project`), which new sessions start in. It is
 * this window's own: a pick here does not change the project other windows remember.
 */
const HOST_PROJECT = new URLSearchParams(location.search).get("project");
/** How many of a project's sessions the start page shows before Show all; pinned ones always show. */
const START_SESSIONS = 5;

type LiveSession = SessionInfo;

/**
 * omp's terminal title is "<icon> <session title>" (or "π <dir>" before one exists): keep the words. Before
 * omp names it, a session reads as the saved list names its file (`saved`, its first message until a title),
 * else as its directory; a chat's directory name means nothing.
 */
function sessionTitle(session: LiveSession, chat: boolean, saved?: string): string {
	const title = session.title?.replace(/^[-\u{F0000}-\u{FFFFD}π\s]+/u, "").trim();
	if (title && title !== "omp" && title !== basename(session.cwd)) return title;
	if (saved) return saved;
	return chat ? "New chat" : basename(session.cwd);
}

interface PeerSession {
	short: string;
	name: string | null;
	cwd: string;
	mode: string;
	busy: boolean;
	accepts: boolean;
	pid: number;
	guiId: string | null;
	sessionId: string;
}

interface SavedSession {
	id: string;
	path: string;
	cwd: string;
	title: string;
	prompt: string;
	modified: string;
	/** omp's listing status: "interrupted" or "pending" when the last turn was cut off. */
	status?: string;
	/** `omp --restore` has a turn to continue; narrower than an interrupted or pending status. */
	restorable?: boolean;
	/** Pinned in omp's session pins (shared with `omp --resume`): listed first. */
	pinned?: boolean;
}

/** A session this server's predecessor hosted when it stopped (its hosted roster). */
interface InterruptedSession {
	guiId: string;
	cwd: string;
	sessionFile?: string;
	title?: string;
	prompt?: string;
	chat: boolean;
	/** Its omp is still running, outliving the server that hosted it. */
	orphan: boolean;
	status?: string;
	/** Its file has a turn `omp --restore` continues. */
	restorable?: boolean;
	/** omp exited on its own before the server stopped (a crash, a signal), as the server recorded it. */
	exit?: { code: number | null; signal: string | number | null };
	/** You ended it while the previous server stopped it, and its omp still runs: it can only be ended. */
	ending?: boolean;
}

interface Project {
	root: string;
	name: string;
	modified: string;
	sessions: SavedSession[];
}

/** GET /api/sessions. */
interface Listing {
	live: LiveSession[];
	projects: Project[];
	chats: SavedSession[];
	chatsDir: string;
	home: string;
	server?: ServerIdentity;
	interrupted?: InterruptedSession[];
}

/** A POST /api/spawn body. */
interface SpawnRequest {
	project?: string;
	resume?: { path: string; cwd: string };
	/** `--restore` instead of `--resume`: continue the turn that was cut off. */
	restore?: boolean;
	/**
	 * The session this restores: an interrupted roster entry, or one of this server run that has exited.
	 * Alone, the server restores it as recorded: it continues its session file with `--restore`, or starts
	 * the first message of a session that died before omp wrote its file again, on its model.
	 */
	from?: string;
	model?: string;
	/** omp's `--thinking` level; absent starts at omp's default. */
	thinking?: string;
	/** omp's `--work-detail` mode: compact, standard or verbose. */
	workDetail?: string;
	/** omp's `--approval-mode`; absent starts in the mode omp's settings name. */
	approvalMode?: string;
	prompt?: string;
}

/** Where a new session runs: a project root, or "" for a chat in its own empty directory. */
type Target = string;

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function tildePath(path: string, home: string): string {
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function ago(timestamp: string): string {
	const ms = Date.now() - Date.parse(timestamp);
	if (!Number.isFinite(ms)) return "";
	const m = Math.round(ms / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

/** Strip omp's leading Nerd Font glyph from a title ("󰒿 SORT: Fix …"). */
function plainTitle(title: string): string {
	return title.replace(/^[-\u{F0000}-\u{FFFFD}\s]+/u, "").trim();
}

function savedLabel(session: SavedSession): string {
	return plainTitle(session.title) || session.prompt || basename(session.cwd);
}

/** What a Restore of a session file says: restoring continues the cut-off turn from where omp recorded it. */
const RESTORE_COST = "A command cut off mid-run runs again, and the turn may spend tokens.";
/** What a Restore of a session omp never saved says: the server starts its first message again. */
const RERUN_COST =
	"omp saved nothing of it, so its first message runs again in a new session, and the task spends tokens again.";

/**
 * The exit codes omp's own signal handlers end with (128 + the signal's number, after its teardown), and
 * the ones a shell reports for a child a signal killed: an exit with one of them was that signal.
 */
const SIGNAL_EXIT_CODES: Record<number, string> = {
	129: "SIGHUP",
	130: "SIGINT",
	131: "SIGQUIT",
	134: "SIGABRT",
	137: "SIGKILL",
	143: "SIGTERM",
};

/** An exit omp did not choose (a signal or a failure code), in words; null for a clean exit. */
function exitCause(exit: { code: number | null; signal: string | number | null } | null | undefined): string | null {
	if (exit?.signal !== null && exit?.signal !== undefined)
		return `omp was killed by ${typeof exit.signal === "number" ? `signal ${exit.signal}` : exit.signal}`;
	if (typeof exit?.code !== "number" || exit.code === 0) return null;
	const signal = SIGNAL_EXIT_CODES[exit.code];
	return signal ? `omp was stopped by ${signal}` : `omp exited with code ${exit.code}`;
}

/** Why a session ended, for its banner; `gone` is a session the server dropped while this view reconnected. */
function exitText(exit: ExitInfo | null | undefined, gone: boolean): string {
	// Within one server run, only End session or a resume of its file takes a session off the server's list.
	if (gone) return "This session was ended, or opened again, while this view was reconnecting.";
	if (exit?.endedBy === "user") return "You ended this session.";
	if (exit?.endedBy === "server") return "This session stopped with the GUI server.";
	const cause = exitCause(exit);
	return cause ? `${cause}.` : "This omp session has ended.";
}

/**
 * The spawn that brings an interrupted roster entry back, or null when it holds nothing to restore. The
 * server restores it as recorded: its session file, or the first message of one that died before omp wrote it.
 */
function restoreRequest(entry: InterruptedSession): SpawnRequest | null {
	return entry.sessionFile || entry.prompt ? { from: entry.guiId } : null;
}

/** What restoring an interrupted entry does, for its Restore button. */
function restoreTitle(entry: InterruptedSession): string {
	return entry.sessionFile
		? `Open it again, continuing a turn that was cut off. ${RESTORE_COST}`
		: `Start it again. ${RERUN_COST}`;
}

/** Restore all's question: how many it starts, and what each kind runs again. */
function restoreAllQuestion(entries: InterruptedSession[]): string {
	const reruns = entries.filter(entry => !entry.sessionFile).length;
	const resumes = entries.length - reruns;
	const parts = [`Restore ${entries.length} sessions?`];
	if (resumes > 0)
		parts.push(
			`${reruns === 0 ? "In each" : `In ${resumes === 1 ? "one" : resumes} of them`}, a command cut off mid-run runs again, and the turn may spend tokens.`,
		);
	if (reruns > 0)
		parts.push(
			resumes === 0
				? "omp saved none of them, so each starts its first message again in a new session, and the task spends tokens again."
				: reruns === 1
					? "omp saved nothing of the other one, so its first message runs again in a new session, and the task spends tokens again."
					: `omp saved nothing of the other ${reruns}, so their first messages run again in new sessions, and the tasks spend tokens again.`,
		);
	return parts.join(" ");
}

/** An unreachable, stopping or refusing server: the page has its own notice for it, and the link watches it. */
function serverWide(err: unknown): boolean {
	return err instanceof ApiError && (err.code === "unreachable" || err.status === 403 || err.status === 503);
}

/** `saved` is what the saved lists call its file: a session resumed from one has no first message of its own. */
function interruptedLabel(entry: InterruptedSession, saved?: string): string {
	return plainTitle(entry.title ?? "") || entry.prompt || saved || (entry.chat ? "New chat" : basename(entry.cwd));
}

/** What Dismiss of a session whose omp still runs means; it asks first. */
const DISMISS_RUNNING = "omp is still running; dismissing leaves it running with no way to end it from here.";

/** Why an interrupted entry is listed: its omp still runs, it exited on its own, or the server stopped under it. */
function interruptedCause(entry: InterruptedSession): string {
	if (entry.orphan)
		return entry.ending ? "Still running after you ended it" : "Still running from the previous server";
	// "omp" stays lower case: it is the program's name.
	if (entry.exit) return exitCause(entry.exit) ?? "omp exited";
	return "Running when the GUI server stopped";
}

type ThemeChoice = "system" | "light" | "dark";

interface Appearance {
	theme: ThemeChoice;
	setTheme: (theme: ThemeChoice) => void;
	prose: string;
	setProse: (prose: string) => void;
}

function useAppearance(): Appearance {
	const [theme, setTheme] = usePref("theme", "system");
	const [prose, setProse] = usePref("prose", "sans");
	useEffect(() => {
		const media = matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
		};
		apply();
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);
	useEffect(() => {
		document.documentElement.dataset.prose = prose;
	}, [prose]);
	return { theme: theme as ThemeChoice, setTheme, prose, setProse };
}

/** Enter or Space on a focused button or link: the page's own click, never keys for omp. */
function activatesControl(event: React.KeyboardEvent): boolean {
	return (
		(event.key === "Enter" || event.key === " ") &&
		(event.target as HTMLElement).closest("button, a, [role=button], [role=menuitem]") !== null
	);
}

function useSession(connection: SessionConnection): number {
	return useSyncExternalStore(
		listener => connection.subscribe(listener),
		() => connection.version,
	);
}

function Surface({ connection, meta }: { connection: SessionConnection; meta: SurfaceMeta }): ReactNode {
	const surface = connection.surfaces.get(meta.id)!;
	const ctx = useMemo<SurfaceContextValue>(
		() => ({ session: connection, store: surface.store, sf: meta.id }),
		[connection, surface.store, meta.id],
	);
	const scrollRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	// A screen surface (settings, full-screen pickers) opens empty and gets its regions in later frames.
	useSyncExternalStore(
		listener => surface.store.subscribe(meta.id, listener),
		() => surface.store.get(meta.id)?.v ?? -1,
	);

	useEffect(() => {
		const scroller = scrollRef.current;
		const inner = innerRef.current;
		if (!scroller || !inner) return;
		const onScroll = () => {
			stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
		};
		const observer = new ResizeObserver(() => {
			if (stick.current) scroller.scrollTop = scroller.scrollHeight;
		});
		observer.observe(inner);
		scroller.addEventListener("scroll", onScroll);
		return () => {
			observer.disconnect();
			scroller.removeEventListener("scroll", onScroll);
		};
	}, []);

	const regions = surface.store.get(meta.id)?.c ?? [];
	const has = (id: string) => regions.includes(id);
	if (meta.mode === "screen") {
		return (
			<SurfaceContext.Provider value={ctx}>
				<div className="surface screen">
					<div className="screen-body">
						{regions.map(id => (
							<N key={id} id={id} />
						))}
					</div>
				</div>
			</SurfaceContext.Provider>
		);
	}
	return (
		<SurfaceContext.Provider value={ctx}>
			<div className={`surface inline ${meta.closed ? "closed" : ""}`}>
				<div className="main-scroll" ref={scrollRef}>
					<div className="main-inner" ref={innerRef}>
						{has("main") ? <Transcript id="main" /> : null}
					</div>
				</div>
				{has("dock") ? (
					<div className="dock">
						<N id="dock" />
					</div>
				) : null}
				{has("layer") ? (
					<div className="layer">
						<N id="layer" />
					</div>
				) : null}
			</div>
		</SurfaceContext.Provider>
	);
}

/** The line above a running session's transcript, if any. */
function viewStatus(connection: SessionConnection, drawn: boolean): string | null {
	if (connection.info?.stopping) return "Stopping omp…";
	if (!connection.connected) return connection.synced ? "Reconnecting…" : "Connecting…";
	return drawn ? null : "Starting omp…";
}

function SessionView({
	connection,
	active,
	spawning,
	onRestore,
}: {
	connection: SessionConnection;
	active: boolean;
	spawning: boolean;
	onRestore: () => void;
}): ReactNode {
	useSession(connection);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = rootRef.current;
		if (!el || !active) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver(entries => {
			const rect = entries[0]!.contentRect;
			clearTimeout(timer);
			timer = setTimeout(
				() =>
					connection.resize(
						Math.floor((Math.min(rect.width, COLUMN_PX) - 56) / 7.6),
						Math.floor(rect.height / 19),
					),
				120,
			);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [connection, active]);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			const target = event.target as HTMLElement;
			// A disclosure head with keyboard focus keeps its keys (Enter/Space toggle it, Tab moves on); only
			// the session view itself and omp's own editor send keys to omp.
			if (target.closest("textarea, input, select, [data-disclosure]") || activatesControl(event)) return;
			const bytes = keyBytes(event.nativeEvent);
			if (bytes === null) return;
			event.preventDefault();
			connection.keys(bytes);
		},
		[connection],
	);

	// F6 moves between omp's prompt and the transcript's disclosure heads, which Tab cannot reach: Tab is omp's.
	// Taken before the editor or the view sends the key on (omp binds no F6).
	const onKeyDownCapture = useCallback((event: React.KeyboardEvent) => {
		if (event.key !== "F6" || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
		const root = rootRef.current;
		if (!root || !toggleTranscriptFocus(root)) return;
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const surfaces = [...connection.surfaces.values()].map(surface => surface.meta);
	const inline = surfaces.filter(meta => meta.mode === "inline");
	const screens = surfaces.filter(meta => meta.mode === "screen");
	const ended = connection.exited || connection.gone;
	const exit = connection.exit;
	// Restore continues the session from its file, or starts its first message again when omp never wrote one;
	// the server says whether either exists (never after a clean exit: /exit cut nothing off). Ending it yourself
	// means you did not want it to go on, and a gone session was ended so, or opened again.
	const restorable = connection.exited && exit?.endedBy !== "user" && exit?.restorable === true;
	const status = ended ? null : viewStatus(connection, inline.length > 0);
	return (
		<div
			className="session-view"
			ref={rootRef}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			onKeyDownCapture={onKeyDownCapture}
			style={{ display: active ? undefined : "none" }}
		>
			{status ? <div className="banner">{status}</div> : null}
			{ended ? (
				<div className="banner ended">
					<div className="ended-line">
						<span>{exitText(exit, connection.gone)}</span>
						{restorable ? (
							<button
								type="button"
								className="btn"
								disabled={spawning}
								title={`Open the session again and continue a turn that was cut off, or start its first message again if omp saved nothing. ${RESTORE_COST}`}
								onClick={onRestore}
							>
								<Icon name="restart" size={13} /> Restore
							</button>
						) : null}
					</div>
					{exit?.lastOutput ? (
						<details className="ended-output">
							<summary>Show omp's last output</summary>
							<pre>{exit.lastOutput}</pre>
						</details>
					) : null}
				</div>
			) : null}
			{inline.slice(-1).map(meta => (
				<Surface key={meta.id} connection={connection} meta={meta} />
			))}
			{/* A screen omp left open when it ended takes no input any more, and would cover the banner's Restore. */}
			{ended ? null : screens.map(meta => <Surface key={meta.id} connection={connection} meta={meta} />)}
		</div>
	);
}

const THEMES = [
	["system", "monitor", "System"],
	["light", "sun", "Light"],
	["dark", "moon", "Dark"],
] as const;

/** The GUI's own settings, shown as the Settings page's General. */
function GeneralSettings({ appearance }: { appearance: Appearance }): ReactNode {
	return (
		<div className="prefs-section">
			<div className="prefs-section-title">Appearance</div>
			<div className="prefs-row">
				<div className="prefs-label">
					Theme
					<div className="s-dim prefs-hint">Light, dark, or whichever the system uses.</div>
				</div>
				<div className="prefs-control seg-toggle" role="radiogroup" aria-label="Theme">
					{THEMES.map(([value, icon, label]) => (
						<button
							key={value}
							type="button"
							className={appearance.theme === value ? "on" : ""}
							onClick={() => appearance.setTheme(value)}
						>
							<Icon name={icon} size={13} /> {label}
						</button>
					))}
				</div>
			</div>
			<div className="prefs-row">
				<div className="prefs-label">
					Answer font
					<div className="s-dim prefs-hint">The typeface of omp's answers in the transcript.</div>
				</div>
				<div className="prefs-control seg-toggle" role="radiogroup" aria-label="Answer font">
					<button
						type="button"
						className={appearance.prose === "sans" ? "on" : ""}
						onClick={() => appearance.setProse("sans")}
					>
						Sans
					</button>
					<button
						type="button"
						className={`serif-aa ${appearance.prose === "serif" ? "on" : ""}`}
						onClick={() => appearance.setProse("serif")}
					>
						Serif
					</button>
				</div>
			</div>
		</div>
	);
}

interface Instructions {
	path: string;
	target?: string;
	text: string;
}

type InstructionsState = { kind: "idle" | "saving" | "saved" | "conflict" | "error"; text?: string };

interface InstructionsDoc {
	/** The file as last read or saved; null until read. */
	loaded: Instructions | null;
	draft: string;
	setDraft: (text: string) => void;
	state: InstructionsState;
	setState: (state: InstructionsState) => void;
	load: () => void;
	save: () => void;
	dirty: boolean;
}

/**
 * The global instructions file and the draft of it, held by the app so an unsaved draft outlives the
 * Instructions page (another Settings page, a session) until a save or a reload.
 */
function useInstructions(): InstructionsDoc {
	const [loaded, setLoaded] = useState<Instructions | null>(null);
	const [draft, setDraft] = useState("");
	const [state, setState] = useState<InstructionsState>({ kind: "idle" });
	const load = useCallback(() => {
		api<Instructions>("/api/instructions").then(
			file => {
				setLoaded(file);
				setDraft(file.text);
				setState({ kind: "idle" });
			},
			err => setState({ kind: "error", text: errorText(err) }),
		);
	}, []);
	const save = () => {
		if (!loaded) return;
		setState({ kind: "saving" });
		api("/api/instructions", { text: draft, base: loaded.text }).then(
			() => {
				setLoaded({ ...loaded, text: draft });
				setState({ kind: "saved" });
			},
			err =>
				setState(
					err instanceof ApiError && err.code === "conflict"
						? { kind: "conflict" }
						: { kind: "error", text: errorText(err) },
				),
		);
	};
	const dirty = loaded !== null && draft !== loaded.text;
	return { loaded, draft, setDraft, state, setState, load, save, dirty };
}

/** The global instructions every omp session loads (`AGENTS.md` in omp's agent directory). */
function InstructionsSettings({ doc }: { doc: InstructionsDoc }): ReactNode {
	const { loaded, draft, setDraft, state, setState, load, save, dirty } = doc;
	// Read once, when first shown; a draft from before stays.
	useEffect(() => {
		if (!loaded && state.kind === "idle") load();
	}, [loaded, state.kind, load]);
	return (
		<div className="prefs-section instructions">
			<div className="prefs-section-title">Global instructions</div>
			<div className="s-dim prefs-hint">
				Every omp session loads these, before a project's own AGENTS.md. New sessions see a change; running ones
				keep what they loaded.
			</div>
			{loaded ? (
				<div className="s-dim prefs-hint instructions-path">
					{loaded.path}
					{loaded.target ? ` → ${loaded.target}` : ""}
				</div>
			) : null}
			<textarea
				className="instructions-text"
				wrap="off"
				value={draft}
				disabled={!loaded}
				spellCheck={false}
				placeholder={loaded ? "No global instructions yet" : "Loading…"}
				onChange={event => {
					setDraft(event.target.value);
					if (state.kind === "saved") setState({ kind: "idle" });
				}}
				onKeyDown={event => {
					if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						if (dirty) save();
					}
				}}
			/>
			<div className="instructions-bar">
				<span className={`s-dim ${state.kind === "error" || state.kind === "conflict" ? "error-text" : ""}`}>
					{state.kind === "saved"
						? "Saved"
						: state.kind === "conflict"
							? "AGENTS.md changed elsewhere since this page read it. Reload shows that version and drops your edit here."
							: state.kind === "error"
								? state.text
								: dirty
									? "Unsaved changes"
									: ""}
				</span>
				{state.kind === "conflict" ? (
					<button type="button" className="btn" onClick={load}>
						Reload
					</button>
				) : null}
				<button
					type="button"
					className="btn primary"
					disabled={!dirty || state.kind === "saving"}
					onClick={save}
					title="Save  ⌘S"
				>
					Save
				</button>
			</div>
		</div>
	);
}

interface RoleChoice {
	id: string;
	name: string;
	value: string | null;
}

/** What each chat role is for, as omp uses it. */
const ROLE_HINTS: Record<string, string> = {
	default: "New sessions and the main conversation.",
	smol: "Quick helper work: titles, summaries, small lookups.",
	slow: "Hard problems that need deep reasoning.",
	vision: "Reading images when the main model cannot.",
	plan: "Plan mode.",
	commit: "Commit messages.",
	tiny: "The smallest jobs, often a local model.",
	memory: "Remembering across sessions.",
	task: "Subagents.",
	advisor: "The advisor that reviews the main model's work.",
	widget: "Background job widgets.",
};

/** One role's model and thinking level, written as `provider/id[:level]`. */
function RoleRow({
	role,
	list,
	onSet,
}: {
	role: RoleChoice;
	list: ModelList | null;
	onSet: (value: string | null) => void;
}): ReactNode {
	const value = role.value ?? "";
	const found = list && value ? findModel(value, list) : undefined;
	const model = found ? found.choice.selector : value;
	const level = found?.level ?? "";
	const compose = (nextModel: string, nextLevel: string) =>
		onSet(nextModel ? (nextLevel ? `${nextModel}:${nextLevel}` : nextModel) : null);
	return (
		<div className="prefs-row">
			<div className="prefs-label">
				{role.name}
				<div className="s-dim prefs-hint">{ROLE_HINTS[role.id] ?? `The ${role.id} role.`}</div>
			</div>
			<div className="prefs-control role-pickers">
				<ModelPicker
					value={model}
					list={list}
					unsetLabel={role.id === "default" ? "omp's default" : "Same as Default"}
					onPick={next => compose(next, next === model ? level : "")}
				/>
				{model ? (
					<EffortPicker value={level} model={model} list={list} onPick={next => compose(model, next)} />
				) : null}
			</div>
		</div>
	);
}

/** The models omp's chat roles use: the same assignments as omp's model hub (`/model`). */
function ModelsSettings(): ReactNode {
	const list = useContext(ModelListContext);
	const [roles, setRoles] = useState<RoleChoice[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		api<RoleChoice[]>("/api/model-roles").then(setRoles, err => setError(errorText(err)));
	}, []);
	const set = (id: string, value: string | null) => {
		setRoles(current => current?.map(role => (role.id === id ? { ...role, value } : role)) ?? current);
		api("/api/model-roles", { role: id, value }).catch(err => setError(errorText(err)));
	};
	return (
		<div className="prefs-section">
			<div className="prefs-section-title">Model roles</div>
			<div className="s-dim prefs-hint">
				Saved in omp's global config, like an assignment in /model. Running sessions keep the model they run on.
			</div>
			{error ? <div className="error-text">{error}</div> : null}
			{roles === null && !error ? <div className="s-dim">Loading…</div> : null}
			{roles?.map(role => (
				<RoleRow key={role.id} role={role} list={list} onSet={value => set(role.id, value)} />
			))}
		</div>
	);
}

/** Provider sign-in, through omp's own /login and /logout pickers. */
function AccountsSettings(): ReactNode {
	const act = useContext(PrefsActionContext);
	return (
		<div className="prefs-section">
			<div className="prefs-section-title">Providers & sign-in</div>
			<div className="s-dim prefs-hint">
				omp's provider list with each one's status: sign in with an account (OAuth) or an API key, the same as
				/login in a session. Credentials go to omp's credential store and every session uses them.
			</div>
			<div className="prefs-row">
				<div className="prefs-label">
					Sign in
					<div className="s-dim prefs-hint">Pick a provider; a browser opens for an account sign-in.</div>
				</div>
				<div className="prefs-control">
					<button type="button" className="btn primary" onClick={() => act("accounts", "login")}>
						Sign in…
					</button>
				</div>
			</div>
			<div className="prefs-row">
				<div className="prefs-label">
					Sign out
					<div className="s-dim prefs-hint">Remove a provider's stored credentials.</div>
				</div>
				<div className="prefs-control">
					<button type="button" className="btn" onClick={() => act("accounts", "logout")}>
						Sign out…
					</button>
				</div>
			</div>
		</div>
	);
}

const GUI_PAGES = [
	{ id: "general", label: "General", icon: "settings" },
	{ id: "instructions", label: "Instructions", icon: "file" },
	{ id: "models", label: "Models", icon: "cpu" },
	{ id: "accounts", label: "Providers & Auth", icon: "key" },
];

/** What the GUI's own Settings pages show and change. */
interface GuiSettings {
	appearance: Appearance;
	instructions: InstructionsDoc;
}

const GUI_PAGE_CONTENT: Record<string, (settings: GuiSettings) => ReactNode> = {
	general: ({ appearance }) => <GeneralSettings appearance={appearance} />,
	instructions: ({ instructions }) => <InstructionsSettings doc={instructions} />,
	models: () => <ModelsSettings />,
	accounts: () => <AccountsSettings />,
};

/**
 * The Settings page: the GUI's own General, then omp's settings panel, drawn by an omp of its own
 * (`--settings-panel`) that the server starts for the page and ends when the page goes.
 */
function SettingsPage({ settings, onClose }: { settings: GuiSettings; onClose: () => void }): ReactNode {
	const [connection, setConnection] = useState<SessionConnection | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [page, setPage] = useState<string | null>("general");
	useEffect(() => {
		let cancelled = false;
		let opened: SessionConnection | null = null;
		api<{ id: string }>("/api/settings-panel", {}).then(
			({ id }) => {
				if (cancelled) return;
				opened = new SessionConnection(id);
				setConnection(opened);
			},
			err => setError(errorText(err)),
		);
		return () => {
			cancelled = true;
			opened?.close();
			api("/api/settings-panel/close", {}).catch(() => {});
		};
	}, []);
	return (
		<div className="settings-page">
			{error ? <div className="banner ended">{error}</div> : null}
			{connection ? (
				<PrefsExtraContext.Provider
					value={{
						title: "Settings",
						pages: GUI_PAGES,
						active: page,
						onPick: setPage,
						content: page ? GUI_PAGE_CONTENT[page]?.(settings) : null,
					}}
				>
					<SettingsPanel connection={connection} onClose={onClose} />
				</PrefsExtraContext.Provider>
			) : error ? null : (
				<div className="banner">Opening settings…</div>
			)}
		</div>
	);
}

/** How often, and how many times, Back to settings looks for omp's editor after cancelling a sign-in. */
const BACK_RETRY_MS = 150;
const BACK_RETRIES = 10;

/**
 * omp's editor area while it runs a sign-in for the Settings page (its composer stays hidden), under a bar
 * leading back to the panel. Back cancels a sign-in still open (Esc), then asks omp for its settings.
 */
function SettingsInline({
	connection,
	surface,
}: {
	connection: SessionConnection;
	surface: { meta: SurfaceMeta; store: SurfaceStore };
}): ReactNode {
	const drawn = useSyncExternalStore(
		listener => surface.store.subscribe(surface.meta.id, listener),
		() => (surface.store.get(surface.meta.id)?.c.length ?? 0) > 0,
	);
	if (!drawn) return <div className="banner">Starting omp…</div>;
	const back = (tries = BACK_RETRIES) => {
		const editor = [...surface.store.nodes.values()].find(node => node.k === "editor");
		if (editor) {
			connection.event({ ev: "action", sf: surface.meta.id, id: editor.id, act: "settings.open" });
			return;
		}
		if (tries === BACK_RETRIES) connection.keys("\x1b");
		if (tries > 0) setTimeout(() => back(tries - 1), BACK_RETRY_MS);
	};
	return (
		<div className="settings-inline">
			<div className="settings-inline-bar">
				<span className="s-dim">Sign-in runs below. Back to settings cancels one you have not finished.</span>
				<button type="button" className="btn" onClick={() => back()}>
					Back to settings
				</button>
			</div>
			<Surface connection={connection} meta={surface.meta} />
		</div>
	);
}

/** omp's settings screen; keys outside its fields go to omp (Esc closes it, and the page with it). */
function SettingsPanel({ connection, onClose }: { connection: SessionConnection; onClose: () => void }): ReactNode {
	useSession(connection);
	const ended = connection.exited || connection.gone;
	useEffect(() => {
		if (ended) onClose();
	}, [ended, onClose]);
	const surfaces = [...connection.surfaces.values()];
	const screens = surfaces.map(surface => surface.meta).filter(meta => meta.mode === "screen" && !meta.closed);
	// Without its panel, omp runs a sign-in in its editor area: show that, with the way back.
	const inline = screens.length === 0 ? surfaces.findLast(surface => surface.meta.mode === "inline") : undefined;
	const onKeyDown = (event: React.KeyboardEvent) => {
		// Tab moves between the page's controls; omp's panel draws no focus of its own here.
		if (event.key === "Tab") return;
		if ((event.target as HTMLElement).closest("textarea, input, select") || activatesControl(event)) return;
		const bytes = keyBytes(event.nativeEvent);
		if (bytes === null) return;
		event.preventDefault();
		connection.keys(bytes);
	};
	return (
		<div className="settings-panel" tabIndex={-1} onKeyDown={onKeyDown}>
			{inline ? (
				<SettingsInline connection={connection} surface={inline} />
			) : screens.length === 0 ? (
				<div className="banner">{viewStatus(connection, false) ?? "Starting omp…"}</div>
			) : null}
			{screens.map(meta => (
				<Surface key={meta.id} connection={connection} meta={meta} />
			))}
		</div>
	);
}

/** The bar above a session: its name, where it runs, whether it works, and End session while it runs. */
function SessionHead({
	connection,
	listed,
	home,
	isChat,
	ending,
	saved,
	onEnd,
}: {
	connection: SessionConnection;
	/** The server's listing of the session; it lags the view's own status frames and stops when the server does. */
	listed: LiveSession | undefined;
	home: string;
	isChat: (cwd: string) => boolean;
	ending: boolean;
	/** What the saved lists call a session's file. */
	saved: (session: LiveSession) => string | undefined;
	onEnd: () => void;
}): ReactNode {
	useSession(connection);
	const info = connection.info ?? listed;
	const running = !(connection.exited || connection.gone || info?.exited);
	const stopping = running && (info?.stopping === true || ending);
	return (
		<header className="session-head">
			<span className="head-title">{info ? sessionTitle(info, isChat(info.cwd), saved(info)) : "Session"}</span>
			{info ? <span className="head-path">{isChat(info.cwd) ? "Chat" : tildePath(info.cwd, home)}</span> : null}
			{running && !stopping && info?.busy ? (
				<span className="head-state">
					<span className="starburst" /> Working
				</span>
			) : null}
			<span className="head-spacer" />
			{listed && running ? (
				<button
					type="button"
					className="ghost-btn danger"
					disabled={stopping}
					title={stopping ? "Ending…" : "End session"}
					aria-label={stopping ? "Ending…" : "End session"}
					onClick={onEnd}
				>
					<Icon name="square" size={11} />
					<span className="head-btn-label">{stopping ? "Ending…" : "End session"}</span>
				</button>
			) : null}
		</header>
	);
}

function ProjectPicker({
	target,
	projects,
	home,
	onPick,
	onChoose,
}: {
	target: Target;
	projects: Project[];
	home: string;
	onPick: (target: Target) => void;
	onChoose: () => void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(
		ref,
		open,
		useCallback(() => setOpen(false), []),
	);
	const pick = (value: Target) => {
		setOpen(false);
		onPick(value);
	};
	return (
		<div className="picker" ref={ref}>
			<button
				type="button"
				className="field-chip project"
				title={target ? tildePath(target, home) : "A chat in its own empty folder"}
				onClick={() => setOpen(value => !value)}
			>
				<Icon name={target ? "folder" : "message-circle"} size={14} />
				<span className="chip-label">{target ? basename(target) : "No project"}</span>
				<Icon name="chev-down" size={12} />
			</button>
			{open ? (
				<div className="picker-menu">
					<div className={`picker-item ${target ? "" : "on"}`} onClick={() => pick("")}>
						<Icon name="message-circle" size={14} />
						<span className="side-label">No project</span>
						<span className="side-meta">chat</span>
					</div>
					{projects.length ? <div className="picker-sep" /> : null}
					<div className="picker-scroll">
						{projects.map(project => (
							<div
								key={project.root}
								className={`picker-item ${project.root === target ? "on" : ""}`}
								title={tildePath(project.root, home)}
								onClick={() => pick(project.root)}
							>
								<Icon name="folder" size={14} />
								<span className="side-label">{project.name}</span>
								<span className="side-meta">{project.modified ? ago(project.modified) : "new"}</span>
							</div>
						))}
					</div>
					<div className="picker-sep" />
					<div
						className="picker-item"
						onClick={() => {
							setOpen(false);
							onChoose();
						}}
					>
						<Icon name="folder-open" size={14} />
						<span className="side-label">Choose folder…</span>
					</div>
				</div>
			) : null}
		</div>
	);
}

/** omp's `--work-detail` modes, as the Work details picker offers them; the GUI starts sessions Compact. */
const WORK_DETAILS: Choice[] = [
	{
		value: "compact",
		text: "Compact",
		title: "Thinking and tool calls fold to one line each; click a row to open it",
	},
	{
		value: "standard",
		text: "Standard",
		title: "Tool output shows a short preview, and thinking shows while it streams",
	},
	{ value: "verbose", text: "Verbose", title: "Thinking and tool output stay open" },
];
const DEFAULT_WORK_DETAIL = "compact";

/** The stored Work details choice, or Compact when none (or an unknown one) is stored. */
function workDetailOf(value: string): string {
	return WORK_DETAILS.some(choice => choice.value === value) ? value : DEFAULT_WORK_DETAIL;
}

function WorkDetailPicker({ value, onPick }: { value: string; onPick: (value: string) => void }): ReactNode {
	return (
		<ChoicePicker
			icon="list-collapse"
			label={WORK_DETAILS.find(choice => choice.value === value)?.text ?? value}
			title="How much of its work a session shows: thinking and tool calls folded to one line, a preview, or open. A session's own chip changes it later."
			menuLabel="Work details"
			value={value}
			choices={WORK_DETAILS}
			onPick={onPick}
		/>
	);
}

/** omp's `--approval-mode` values, as its settings panel names them. */
const APPROVAL_MODES: Choice[] = [
	{ value: "always-ask", text: "Always ask", title: "Run read-only tools; ask before every write and command" },
	{
		value: "always-ask-cached",
		text: "Ask and remember",
		title: "Ask before reading or writing a file, with answers that can remember the file or its folder",
	},
	{ value: "write", text: "Write", title: "Run read-only tools and workspace edits; ask before every command" },
	{
		value: "auto",
		text: "Auto",
		title: "Like Write, and a judge model runs routine commands, asks about risky ones and refuses destructive ones",
	},
	{ value: "yolo", text: "Yolo", title: "Run every tool without asking" },
];
const SETTINGS_APPROVAL: Choice = {
	value: "",
	text: "From settings",
	title: "The mode omp's settings name (tools.approvalMode)",
};

/** The stored approval choice, or "" (omp's settings) when none, or an unknown one, is stored. */
function approvalModeOf(value: string): string {
	return APPROVAL_MODES.some(choice => choice.value === value) ? value : "";
}

function ApprovalPicker({ value, onPick }: { value: string; onPick: (value: string) => void }): ReactNode {
	return (
		<ChoicePicker
			icon="key"
			label={APPROVAL_MODES.find(choice => choice.value === value)?.text ?? "Approvals"}
			title="Which tool calls a new session asks you about first. Every mode asks before a critical command such as rm -rf /. A picked mode holds for the session's life; From settings follows /settings."
			menuLabel="Approvals"
			value={value}
			lead={[SETTINGS_APPROVAL]}
			choices={APPROVAL_MODES}
			onPick={onPick}
		/>
	);
}

function StartPage({
	picker,
	modelPicker,
	interrupted,
	recent,
	recentTitle,
	spawning,
	isCutOff,
	onStart,
	onResume,
	onRestore,
	onPin,
}: {
	picker: ReactNode;
	modelPicker: ReactNode;
	/** The "Running when the GUI server stopped" section, when there is one. */
	interrupted: ReactNode;
	/** The chosen project's saved sessions (or the chats), pinned first. */
	recent: SavedSession[];
	recentTitle: string;
	spawning: boolean;
	isCutOff: (session: SavedSession) => boolean;
	onStart: (prompt: string) => void;
	onResume: (session: SavedSession) => void;
	onRestore: (session: SavedSession) => void;
	onPin: (session: SavedSession) => void;
}): ReactNode {
	const [prompt, setPrompt] = useState("");
	const [showAll, setShowAll] = useState(false);
	useEffect(() => setShowAll(false), [recentTitle]);
	const shown = showAll
		? recent
		: recent.filter((session, index) => index < START_SESSIONS || session.pinned || isCutOff(session));
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const start = () => onStart(prompt);
	return (
		<div className="start">
			<div className="start-inner">
				<h1 className="start-title">
					<OmpMark size={40} />
					omp
				</h1>
				<div className="start-box">
					<textarea
						ref={ref}
						value={prompt}
						onChange={event => setPrompt(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								// A held Enter repeats; only the first press starts a session.
								if (!event.repeat) start();
							}
						}}
						placeholder="Describe a task for omp, or start with an empty session"
						spellCheck={false}
					/>
					<div className="start-bar">
						{picker}
						{modelPicker}
						<button
							type="button"
							className="send-btn"
							onClick={start}
							disabled={spawning}
							title="Start session  ⏎"
						>
							<Icon name="arrow-up" size={16} />
						</button>
					</div>
				</div>
				<div className="start-hint">Enter starts the session, Shift+Enter adds a line.</div>
				{interrupted}
				{recent.length ? (
					<div className="start-recent">
						<div className="side-title start-recent-head">
							<span className="start-recent-title">{recentTitle}</span>
							{recent.length > shown.length || showAll ? (
								<button type="button" className="ghost-btn" onClick={() => setShowAll(all => !all)}>
									{showAll ? "Show fewer" : `Show all ${recent.length}`}
								</button>
							) : null}
						</div>
						{shown.map(session => (
							<SavedItem
								key={session.id}
								className=""
								session={session}
								lead={<Icon name="history" size={13} />}
								cutOff={isCutOff(session)}
								spawning={spawning}
								onResume={() => onResume(session)}
								onRestore={() => onRestore(session)}
								onPin={() => onPin(session)}
							/>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * A saved session: a click resumes it. One whose last turn was cut off is marked, and only its own
 * Restore button continues that turn, since continuing spends tokens.
 */
function SavedItem({
	session,
	className = "recent",
	lead = null,
	cutOff,
	spawning,
	onResume,
	onRestore,
	onPin,
	where,
}: {
	session: SavedSession;
	className?: string;
	lead?: ReactNode;
	/** Which project (or "Chat") it belongs to, where a list mixes them. */
	where?: string;
	cutOff: boolean;
	spawning: boolean;
	onResume: () => void;
	onRestore: () => void;
	onPin: () => void;
}): ReactNode {
	return (
		<div
			className={`side-item ${className} ${spawning ? "waiting" : ""}`}
			onClick={onResume}
			title={`${session.cwd}\n${session.prompt}`}
		>
			<span className="side-lead">{lead}</span>
			<span className="side-label">{savedLabel(session)}</span>
			<button
				type="button"
				className={`side-pin ${session.pinned ? "on" : ""}`}
				title={session.pinned ? "Unpin" : "Pin: keep it at the top of its list"}
				aria-label={session.pinned ? "Unpin" : "Pin"}
				aria-pressed={session.pinned === true}
				onClick={event => {
					event.stopPropagation();
					onPin();
				}}
			>
				<Icon name="pin" size={12} />
			</button>
			{cutOff ? (
				<>
					<span className="side-mark" title="Its last turn was cut off">
						Interrupted
					</span>
					<button
						type="button"
						className="side-restore"
						disabled={spawning}
						title={`Restore: open it and continue the turn that was cut off. ${RESTORE_COST}`}
						aria-label="Restore"
						onClick={event => {
							event.stopPropagation();
							onRestore();
						}}
					>
						<Icon name="restart" size={12} />
					</button>
				</>
			) : (
				<span className="side-meta">
					{where ? `${where} · ` : ""}
					{ago(session.modified)}
				</span>
			)}
		</div>
	);
}

/** Whether `cwd` is `root` or a folder inside it. */
function within(cwd: string, root: string): boolean {
	return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * The history menu, opened from the top right of the narrow layout (an editor's side bar): every session to
 * go back to, the running ones first, then the saved ones pinned first and newest next, for the chosen
 * project or for all of them, narrowed by a search.
 */
function HistoryMenu({
	live,
	saved,
	projectName,
	projectRoot,
	liveLabel,
	whereOf,
	isCutOff,
	spawning,
	onOpenLive,
	onResume,
	onRestore,
	onPin,
	onClose,
}: {
	live: LiveSession[];
	/** Every saved session the page lists (projects and chats), pinned first. */
	saved: SavedSession[];
	/** The chosen project, whose sessions the menu shows first; null for a chat. */
	projectName: string | null;
	projectRoot: string | null;
	liveLabel: (session: LiveSession) => string;
	/** The project a saved session belongs to, shown while the menu lists every project. */
	whereOf: (session: SavedSession) => string;
	isCutOff: (session: SavedSession) => boolean;
	spawning: boolean;
	onOpenLive: (id: string) => void;
	onResume: (session: SavedSession) => void;
	onRestore: (session: SavedSession) => void;
	onPin: (session: SavedSession) => void;
	onClose: () => void;
}): ReactNode {
	const [query, setQuery] = useState("");
	const [all, setAll] = useState(projectRoot === null);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const needle = query.trim().toLowerCase();
	const matches = (...texts: string[]) => !needle || texts.some(text => text.toLowerCase().includes(needle));
	const inScope = (cwd: string) => all || projectRoot === null || within(cwd, projectRoot);
	const running = live.filter(
		session => !session.exited && inScope(session.cwd) && matches(liveLabel(session), session.cwd),
	);
	const runningFiles = new Set(running.flatMap(session => (session.sessionFile ? [session.sessionFile] : [])));
	const listed = saved.filter(
		session =>
			!runningFiles.has(session.path) &&
			inScope(session.cwd) &&
			matches(savedLabel(session), session.prompt, session.cwd),
	);
	return (
		<>
			<div className="history-backdrop" onClick={onClose} />
			<div
				className="history-menu"
				role="dialog"
				aria-label="Session history"
				onKeyDown={event => {
					if (event.key === "Escape") onClose();
				}}
			>
				<div className="history-search">
					<Icon name="search" size={13} />
					<input
						ref={ref}
						value={query}
						onChange={event => setQuery(event.target.value)}
						placeholder="Search sessions"
						spellCheck={false}
					/>
				</div>
				{projectRoot !== null ? (
					<div className="seg-toggle history-scope" role="radiogroup" aria-label="Which sessions">
						<button type="button" className={all ? "" : "on"} onClick={() => setAll(false)}>
							{projectName}
						</button>
						<button type="button" className={all ? "on" : ""} onClick={() => setAll(true)}>
							All
						</button>
					</div>
				) : null}
				<div className="history-list">
					{running.length ? <div className="side-title">Running</div> : null}
					{running.map(session => (
						<div
							key={session.id}
							className="side-item recent"
							title={session.cwd}
							onClick={() => onOpenLive(session.id)}
						>
							<span className="side-lead">
								<span className={`dot ${session.busy ? "tone-pending" : "tone-success"}`} />
							</span>
							<span className="side-label">{liveLabel(session)}</span>
							{session.busy ? <span className="side-meta">Working</span> : null}
						</div>
					))}
					{running.length && listed.length ? <div className="side-title">Saved</div> : null}
					{listed.map(session => (
						<SavedItem
							key={session.id}
							session={session}
							lead={<Icon name="history" size={13} />}
							where={all ? whereOf(session) : undefined}
							cutOff={isCutOff(session)}
							spawning={spawning}
							onResume={() => onResume(session)}
							onRestore={() => onRestore(session)}
							onPin={() => onPin(session)}
						/>
					))}
					{running.length + listed.length === 0 ? (
						<div className="side-empty">{needle ? "No sessions match" : "No sessions yet"}</div>
					) : null}
				</div>
			</div>
		</>
	);
}

/** Sessions the previous GUI server hosted that did not finish: bring each back, or let it go. */
function InterruptedList({
	entries,
	home,
	spawning,
	acting,
	onRestore,
	onDismiss,
	onEnd,
	saved,
}: {
	entries: InterruptedSession[];
	home: string;
	/** What the saved lists call a session file. */
	saved: (file: string | undefined) => string | undefined;
	spawning: boolean;
	/** Entries with a dismiss or end request in flight. */
	acting: ReadonlySet<string>;
	onRestore: (entries: InterruptedSession[]) => void;
	/** `force` forgets sessions whose omp still runs, which nothing here can end afterwards. */
	onDismiss: (entries: InterruptedSession[], force?: boolean) => void;
	onEnd: (entry: InterruptedSession) => void;
}): ReactNode {
	const restorable = entries.filter(entry => !entry.orphan && restoreRequest(entry));
	/** Dismiss all forgets only sessions whose omp is gone; one still running is dismissed on its own, after a question. */
	const finished = entries.filter(entry => !entry.orphan);
	/** Restore all asks first: every one of them may run a command again and spend tokens. */
	const [confirming, setConfirming] = useState(false);
	const asking = confirming && restorable.length > 1;
	/** The still-running session whose Dismiss is asking first. */
	const [dismissing, setDismissing] = useState<string | null>(null);
	return (
		<div className="start-recent interrupted">
			<div className="side-title interrupted-head">
				<span>Unfinished sessions</span>
				<span className="head-spacer" />
				{restorable.length > 1 ? (
					<button
						type="button"
						className="ghost-btn"
						disabled={spawning || asking}
						title={`Restore every session listed here. ${RESTORE_COST}${restorable.every(entry => entry.sessionFile) ? "" : " A session omp never saved starts its first message again, and the task spends tokens again."}`}
						onClick={() => setConfirming(true)}
					>
						Restore all
					</button>
				) : null}
				{finished.length > 1 ? (
					<button
						type="button"
						className="ghost-btn"
						title={
							finished.length < entries.length
								? "Forget every session listed here whose omp has ended; one still running stays"
								: "Forget every session listed here"
						}
						onClick={() => onDismiss(finished)}
					>
						Dismiss all
					</button>
				) : null}
			</div>
			{asking ? (
				<div className="restore-confirm" role="alertdialog" aria-label="Restore all">
					<span className="restore-confirm-text">{restoreAllQuestion(restorable)}</span>
					<button
						type="button"
						className="btn"
						disabled={spawning}
						onClick={() => {
							setConfirming(false);
							onRestore(restorable);
						}}
					>
						Restore {restorable.length}
					</button>
					<button type="button" className="ghost-btn" onClick={() => setConfirming(false)}>
						Cancel
					</button>
				</div>
			) : null}
			{entries.map(entry => (
				<Fragment key={entry.guiId}>
					<div className="side-item interrupted-item" title={tildePath(entry.cwd, home)}>
						<span className="side-lead">
							<Icon name={entry.orphan ? "activity" : entry.chat ? "message-circle" : "folder"} size={13} />
						</span>
						<span className="side-text">
							<span className="side-label">{interruptedLabel(entry, saved(entry.sessionFile))}</span>
							<span className={`side-cause ${entry.exit && !entry.orphan ? "failed" : ""}`}>
								{interruptedCause(entry)} · {entry.chat ? "chat" : basename(entry.cwd)}
							</span>
						</span>
						{!entry.orphan && entry.restorable ? (
							<span className="side-mark" title="Its last turn was cut off">
								Interrupted
							</span>
						) : null}
						{acting.has(entry.guiId) ? (
							<span className="side-meta">{entry.orphan ? "Ending…" : "Dismissing…"}</span>
						) : (
							<span className="item-actions">
								{entry.orphan ? (
									<button
										type="button"
										className="ghost-btn danger"
										title="Stop that omp and forget it"
										onClick={() => onEnd(entry)}
									>
										End
									</button>
								) : restoreRequest(entry) ? (
									<button
										type="button"
										className="ghost-btn"
										disabled={spawning}
										title={restoreTitle(entry)}
										onClick={() => onRestore([entry])}
									>
										Restore
									</button>
								) : null}
								<button
									type="button"
									className="ghost-btn"
									title={entry.orphan ? `Forget it. ${DISMISS_RUNNING}` : "Forget it"}
									onClick={() => (entry.orphan ? setDismissing(entry.guiId) : onDismiss([entry]))}
								>
									Dismiss
								</button>
							</span>
						)}
					</div>
					{dismissing === entry.guiId && entry.orphan && !acting.has(entry.guiId) ? (
						<div className="restore-confirm" role="alertdialog" aria-label="Dismiss">
							<span className="restore-confirm-text">{DISMISS_RUNNING}</span>
							<button
								type="button"
								className="btn"
								onClick={() => {
									setDismissing(null);
									onDismiss([entry], true);
								}}
							>
								Dismiss anyway
							</button>
							<button type="button" className="ghost-btn" onClick={() => setDismissing(null)}>
								Cancel
							</button>
						</div>
					) : null}
				</Fragment>
			))}
		</div>
	);
}

/** App-wide lines about the GUI server, a spawn that waits, and this window's environment. */
function Notices({ waiting }: { waiting: boolean }): ReactNode {
	const state = useSyncExternalStore(
		listener => link.subscribe(listener),
		() => link.state,
	);
	const replaced = useSyncExternalStore(
		listener => link.subscribe(listener),
		() => link.replaced,
	);
	const [envHidden, setEnvHidden] = useState(false);
	const degraded = DEGRADED_ENV && !envHidden;
	if (state === "up" && !replaced && !degraded && !waiting) return null;
	return (
		<div className="notices">
			{waiting && state === "up" ? (
				<div className="notice" role="status">
					<span className="spin" />
					<span className="notice-text">Waiting for the previous omp to finish shutting down…</span>
				</div>
			) : null}
			{state === "down" ? (
				<div className="notice warn">
					<Icon name="warning" size={14} />
					<span className="notice-text">GUI server not reachable</span>
					<button type="button" className="btn" onClick={() => link.retryNow()}>
						Reconnect now
					</button>
				</div>
			) : null}
			{state === "stopping" ? (
				<div className="notice">
					<Icon name="info" size={14} />
					<span className="notice-text">The GUI server is stopping</span>
				</div>
			) : null}
			{state === "rejected" ? (
				<div className="notice warn">
					<Icon name="warning" size={14} />
					<span className="notice-text">
						The GUI server no longer accepts this page; open it again with <code>omp gui</code>
					</span>
				</div>
			) : null}
			{replaced ? (
				<div className="notice">
					<Icon name="info" size={14} />
					<span className="notice-text">omp was reinstalled; restart the GUI server to use the new version</span>
				</div>
			) : null}
			{degraded ? (
				<div className="notice">
					<Icon name="info" size={14} />
					<span className="notice-text">
						Login-shell environment unavailable: tools on your PATH may be missing
					</span>
					<button
						type="button"
						className="notice-close"
						title="Hide"
						aria-label="Hide"
						onClick={() => setEnvHidden(true)}
					>
						<Icon name="close" size={13} />
					</button>
				</div>
			) : null}
		</div>
	);
}

export function App(): ReactNode {
	const [live, setLive] = useState<LiveSession[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [chats, setChats] = useState<SavedSession[]>([]);
	const [chatsDir, setChatsDir] = useState("");
	const [peers, setPeers] = useState<PeerSession[]>([]);
	const [home, setHome] = useState("");
	const [copied, setCopied] = useState<string | null>(null);
	const [open, setOpen] = useState<string[]>([]);
	const [active, setActive] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);
	/** Whether the session list is pulled out over the page, where the window is too narrow to keep it beside it. */
	const [drawer, setDrawer] = useState(false);
	const [rememberedTarget, setRememberedTarget] = usePref("project", "");
	const [hostTarget, setHostTarget] = useState<Target>(HOST_PROJECT ?? "");
	const target = HOST_PROJECT === null ? rememberedTarget : hostTarget;
	const setTarget = HOST_PROJECT === null ? setRememberedTarget : setHostTarget;
	const [chosen, setChosen] = useState<string | null>(null);
	const [modelPref, setModel] = usePref("model", "");
	const model = modelPref.trim();
	const [thinkingPref, setThinking] = usePref("thinking", "");
	const thinkingChoice = thinkingPref.trim();
	const [workDetailPref, setWorkDetail] = usePref("workDetail", "");
	const [approvalPref, setApproval] = usePref("approvalMode", "");
	const approvalMode = approvalModeOf(approvalPref);
	const pinnedRoots = usePinnedProjects();
	const toggleProjectPin = (root: string) => pinProject(root, !pinnedRoots.includes(root));
	const workDetail = workDetailOf(workDetailPref);
	const [modelList, setModelList] = useState<ModelList | null>(null);
	const [interrupted, setInterrupted] = useState<InterruptedSession[]>([]);
	/** What the last action (spawn, end, choose folder) failed with; cleared by the next. */
	const [error, setError] = useState<string | null>(null);
	/** What the last listing failed with; cleared by the next that succeeds. */
	const [listError, setListError] = useState<string | null>(null);
	const [spawning, setSpawning] = useState(false);
	/** A spawn that opens a session file has waited over a second: the server may be waiting for the omp that held it. */
	const [waiting, setWaiting] = useState(false);
	/** Live sessions with an End request in flight. */
	const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
	/** Interrupted entries, and exited live sessions, with a Dismiss or End request in flight. */
	const [acting, setActing] = useState<ReadonlySet<string>>(new Set());
	const connections = useRef(new Map<string, SessionConnection>());
	/** One spawn at a time, whichever button or key asked for it; state lags a fast double press, a ref does not. */
	const spawnInFlight = useRef(false);
	const appearance = useAppearance();
	const instructions = useInstructions();

	/** Fetch the listing into state; it resolves with the listing, or null when that failed. */
	const refresh = useCallback(async (): Promise<Listing | null> => {
		try {
			const data = await api<Listing>("/api/sessions");
			link.observe(data.server);
			setLive(data.live);
			setProjects(data.projects);
			setChats(data.chats);
			setChatsDir(data.chatsDir);
			setHome(data.home);
			setInterrupted(data.interrupted ?? []);
			setPeers(await api<PeerSession[]>("/api/peers"));
			setListError(null);
			return data;
		} catch (err) {
			if (!serverWide(err)) setListError(errorText(err));
			return null;
		}
	}, []);

	// Picking a session, a new one or a project in the drawer is done with it.
	/** The project the target folder belongs to (its checkout, else itself), as the server groups sessions. */
	const [targetRoot, setTargetRoot] = useState<string | null>(null);
	useEffect(() => {
		setTargetRoot(null);
		if (!target) return;
		let current = true;
		api<{ root: string }>(`/api/project-root?dir=${encodeURIComponent(target)}`).then(
			({ root }) => current && setTargetRoot(root),
			() => {},
		);
		return () => {
			current = false;
		};
	}, [target]);
	/** Whether the narrow layout's history menu is open. */
	const [history, setHistory] = useState(false);
	useEffect(() => {
		setDrawer(false);
		setHistory(false);
	}, [active, target, settingsOpen]);

	useEffect(() => {
		void refresh();
		// While the server is not answering the link probes it with a backoff, and refreshes once it is back.
		const timer = setInterval(() => {
			if (link.state === "up") void refresh();
		}, 5000);
		let state = link.state;
		const unsubscribe = link.subscribe(() => {
			if (link.state === "up" && state !== "up") void refresh();
			state = link.state;
		});
		return () => {
			clearInterval(timer);
			unsubscribe();
		};
	}, [refresh]);

	const connect = (id: string) => {
		if (!connections.current.has(id)) connections.current.set(id, new SessionConnection(id));
	};

	const show = (id: string) => {
		connect(id);
		setOpen(list => (list.includes(id) ? list : [...list, id]));
		setActive(id);
		setSettingsOpen(false);
	};

	/** Close a session's view (its omp keeps running unless it was ended). */
	const forget = (id: string) => {
		connections.current.get(id)?.close();
		connections.current.delete(id);
		setOpen(list => list.filter(item => item !== id));
		setActive(current => (current === id ? null : current));
	};

	// Read again on leaving Settings, where the default model may have changed.
	useEffect(() => {
		if (settingsOpen) return;
		api<ModelList>("/api/models").then(setModelList, err => {
			if (!serverWide(err)) setError(errorText(err));
		});
	}, [settingsOpen]);

	const chooseFolder = async () => {
		setError(null);
		try {
			const { path } = await api<{ path: string | null }>("/api/choose-folder", {});
			if (!path) return;
			setChosen(path);
			setTarget(path);
		} catch (err) {
			setError(errorText(err));
		}
	};

	/**
	 * Start sessions, one request after another, and show the first. Every entry point (start page, recent and
	 * sidebar items, Restore) comes through here, and a request while one is in flight is dropped, so a double
	 * press never starts two agents.
	 */
	/**
	 * A spawn the server may hold, waiting for the omp that has its session file to let go: a resume, or a
	 * restore of a session that has a file. A restore of a first message opens none.
	 */
	const opensFile = (request: SpawnRequest): boolean =>
		request.resume !== undefined ||
		(request.from !== undefined &&
			Boolean(
				interrupted.find(entry => entry.guiId === request.from)?.sessionFile ??
				connections.current.get(request.from)?.info?.sessionFile,
			));

	const spawn = async (requests: SpawnRequest[], replaces?: string) => {
		if (spawnInFlight.current) return;
		spawnInFlight.current = true;
		setSpawning(true);
		setError(null);
		try {
			const ids: string[] = [];
			const errors: string[] = [];
			for (const request of requests) {
				// The page sends its work-detail and approval picks on every spawn. A bare restore keeps the
				// modes the session was recorded with when there are any; any other spawn takes the picks.
				const body: SpawnRequest = { ...request, workDetail, approvalMode: approvalMode || undefined };
				// The server waits up to 10 s for another omp to let go of the session file (one still tearing down).
				const timer = opensFile(request) ? setTimeout(() => setWaiting(true), WAITING_MS) : undefined;
				try {
					ids.push((await api<{ id: string }>("/api/spawn", body)).id);
				} catch (err) {
					errors.push(errorText(err));
				} finally {
					clearTimeout(timer);
					setWaiting(false);
				}
			}
			if (errors.length) setError(errors.join("\n"));
			if (replaces && ids.length) forget(replaces);
			if (requests.length) await refresh();
			// Two requests may come back as one session: the server answers a resume of a file it already runs
			// with that session, as when two roster entries name the same file.
			const unique = [...new Set(ids)];
			for (const id of unique.slice(1)) connect(id);
			if (unique.length) {
				setOpen(current => [...current, ...unique.filter(id => !current.includes(id))]);
				show(unique[0]!);
			}
		} finally {
			spawnInFlight.current = false;
			setSpawning(false);
		}
	};

	// The level a session starts at: the picked one when the picked model takes it, else omp's default.
	const thinking =
		thinkingChoice && thinkingFor(model, modelList).choices.includes(thinkingChoice) ? thinkingChoice : "";

	const resumeRequest = (session: SavedSession): SpawnRequest => ({
		resume: { path: session.path, cwd: session.cwd },
		model: model || undefined,
		thinking: thinking || undefined,
	});

	// --restore takes no prompt, and the turn continues on the model it was running.
	const restoreSaved = (session: SavedSession) =>
		void spawn([{ resume: { path: session.path, cwd: session.cwd }, restore: true }]);

	const stopSession = async (id: string) => {
		if (ending.has(id)) return;
		setEnding(set => new Set(set).add(id));
		setError(null);
		try {
			// Returns once omp has exited, or the server gave up on it; the view shows "Stopping omp…" meanwhile.
			const { ok } = await api<{ ok: boolean }>("/api/kill", { id });
			if (ok) forget(id);
			else {
				const pid = connections.current.get(id)?.info?.pid ?? live.find(session => session.id === id)?.pid;
				setError(`omp did not exit when ended; it may still be running${pid ? ` (pid ${pid})` : ""}.`);
			}
		} catch (err) {
			setError(errorText(err));
		} finally {
			setEnding(set => {
				const next = new Set(set);
				next.delete(id);
				return next;
			});
			void refresh();
		}
	};

	/**
	 * Dismiss (forget) or End (stop the orphaned omp, then forget) interrupted entries. A dismiss with `force`
	 * forgets one whose omp still runs; the server refuses that without it.
	 */
	const settleInterrupted = async (entries: InterruptedSession[], verb: "dismiss" | "end", force = false) => {
		const pending = entries.filter(entry => !acting.has(entry.guiId));
		if (pending.length === 0) return;
		const ids = pending.map(entry => entry.guiId);
		setActing(set => new Set([...set, ...ids]));
		setError(null);
		const results = await Promise.allSettled(
			ids.map(guiId => api<{ ok: boolean }>(`/api/interrupted/${verb}`, force ? { guiId, force } : { guiId })),
		);
		const failed = results.flatMap((result, index) => {
			if (result.status === "rejected") return [errorText(result.reason)];
			// An orphan that outlived SIGINT and the SIGKILL of its process group stays listed, still running.
			return result.value.ok
				? []
				: [
						`${interruptedLabel(pending[index]!, savedOf(pending[index]!.sessionFile))}: omp did not exit; it is still running.`,
					];
		});
		if (failed.length) setError(failed.join("\n"));
		setActing(set => new Set([...set].filter(id => !ids.includes(id))));
		await refresh();
	};

	/** Take a session that has exited off the list, with its roster entry; its view closes. */
	const dismissLive = async (id: string) => {
		if (acting.has(id)) return;
		setActing(set => new Set(set).add(id));
		setError(null);
		try {
			await api<{ ok: boolean }>(DISMISS_PATH, { guiId: id });
			forget(id);
		} catch (err) {
			// Already gone from the server (another window dismissed or restored it): only the view is left to close.
			if (err instanceof ApiError && err.status === 404) forget(id);
			else setError(errorText(err));
		} finally {
			setActing(set => new Set([...set].filter(item => item !== id)));
			void refresh();
		}
	};

	// Sessions running right now, here or in another omp process, are not interrupted whatever their file says.
	const running = new Set([
		...live.flatMap(session => (!session.exited && session.sessionFile ? [session.sessionFile] : [])),
		...peers.map(peer => peer.sessionId),
	]);
	const isCutOff = (session: SavedSession) =>
		session.restorable === true && !running.has(session.path) && !running.has(session.id);

	const activeConnection = active === null ? undefined : connections.current.get(active);
	const isChat = (cwd: string) => Boolean(chatsDir) && (cwd === chatsDir || cwd.startsWith(`${chatsDir}/`));
	// A folder just chosen (or remembered from last time) may have no saved session yet, so the store does not list it.
	const extra = [chosen, target].find(root => root && !projects.some(project => project.root === root));
	const pickable = extra
		? [{ root: extra, name: basename(extra), modified: "", sessions: [] }, ...projects]
		: projects;
	// What the saved lists call a live session's file, so the sidebar and its head agree before omp titles it.
	const savedNames = new Map(
		[...chats, ...projects.flatMap(project => project.sessions)].map(item => [item.path, savedLabel(item)]),
	);
	const savedOf = (file: string | undefined): string | undefined => (file ? savedNames.get(file) : undefined);
	const savedName = (session: LiveSession): string | undefined => savedOf(session.sessionFile);
	const targetProject = target ? projects.find(project => project.root === (targetRoot ?? target)) : undefined;
	const recentForTarget = target ? (targetProject?.sessions ?? []) : chats;
	const allSaved = [...projects.flatMap(project => project.sessions), ...chats].sort(
		(a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.modified.localeCompare(a.modified),
	);
	const runningCount = live.filter(session => !session.exited).length;
	// Pinned projects lead the sidebar, in the order they were pinned; pinned sessions have a section of their own.
	const sideProjects = [
		...pinnedRoots.flatMap(root => projects.filter(project => project.root === root)),
		...projects.filter(project => !pinnedRoots.includes(project.root)),
	];
	const pinnedSessions = allSaved.filter(session => session.pinned);
	const unpinned = (sessions: SavedSession[]) => sessions.filter(session => !session.pinned);
	const projectNames = new Map(
		projects.flatMap(project => project.sessions.map(session => [session.path, project.name] as const)),
	);
	const recentTitle = target ? `Sessions in ${targetProject?.name ?? basename(target)}` : "Chats";
	const pin = async (session: SavedSession) => {
		setError(null);
		try {
			await api("/api/pin", { id: session.id, pinned: !session.pinned });
		} catch (err) {
			if (!serverWide(err)) setError(errorText(err));
		}
		await refresh();
	};
	/** The first `count` sessions, plus every later one whose turn was cut off, so none hides below the fold. */
	const listed = (sessions: SavedSession[], count: number) =>
		sessions.filter((session, index) => index < count || isCutOff(session));
	const savedItem = (session: SavedSession) => (
		<SavedItem
			key={session.id}
			session={session}
			cutOff={isCutOff(session)}
			spawning={spawning}
			onResume={() => void spawn([resumeRequest(session)])}
			onRestore={() => restoreSaved(session)}
			onPin={() => void pin(session)}
		/>
	);
	const newIn = (value: Target) => {
		setTarget(value);
		setActive(null);
		setSettingsOpen(false);
	};
	return (
		<div className={`app ${drawer ? "drawer-open" : ""}`}>
			<button
				type="button"
				className="drawer-toggle"
				title={drawer ? "Hide sessions" : "Show sessions"}
				aria-label={drawer ? "Hide sessions" : "Show sessions"}
				aria-expanded={drawer}
				onClick={() => setDrawer(open => !open)}
			>
				<Icon name="panel-left" size={16} />
			</button>
			<div className="drawer-backdrop" onClick={() => setDrawer(false)} />
			<div className="top-actions">
				<button
					type="button"
					className={`top-action ${history ? "on" : ""}`}
					title="Session history"
					aria-label={`Session history, ${runningCount} running`}
					aria-expanded={history}
					onClick={() => setHistory(open => !open)}
				>
					<Icon name="clock" size={15} />
					{runningCount ? <span className="top-badge">{runningCount}</span> : null}
				</button>
				<button
					type="button"
					className="top-action"
					title="New session"
					aria-label="New session"
					onClick={() => newIn(target)}
				>
					<Icon name="square-pen" size={15} />
				</button>
			</div>
			{history ? (
				<HistoryMenu
					live={live}
					saved={allSaved}
					projectName={targetProject?.name ?? (target ? basename(target) : null)}
					projectRoot={target ? (targetProject?.root ?? target) : null}
					liveLabel={session => sessionTitle(session, isChat(session.cwd), savedName(session))}
					whereOf={session => projectNames.get(session.path) ?? "Chat"}
					isCutOff={isCutOff}
					spawning={spawning}
					onOpenLive={id => {
						setHistory(false);
						show(id);
					}}
					onResume={session => {
						setHistory(false);
						void spawn([resumeRequest(session)]);
					}}
					onRestore={session => {
						setHistory(false);
						restoreSaved(session);
					}}
					onPin={session => void pin(session)}
					onClose={() => setHistory(false)}
				/>
			) : null}
			<aside className="sidebar">
				<div className="side-top">
					<div className="brand">
						<OmpMark size={22} />
						omp
					</div>
					<button
						type="button"
						className={`new-session ${active === null && !settingsOpen ? "active" : ""}`}
						onClick={() => {
							setActive(null);
							setSettingsOpen(false);
						}}
					>
						<Icon name="plus" size={15} /> New session
					</button>
				</div>
				<div className="side-scroll">
					{error ? <div className="error-text">{error}</div> : null}
					{listError ? <div className="error-text">{listError}</div> : null}
					<div className="side-title">Sessions</div>
					{live.length === 0 ? <div className="side-empty">Nothing running</div> : null}
					{live.map(session => {
						const stopping = !session.exited && (session.stopping || ending.has(session.id));
						return (
							<div
								key={session.id}
								className={`side-item ${session.id === active && !settingsOpen ? "active" : ""}`}
								onClick={() => show(session.id)}
								title={session.cwd}
							>
								<span className="side-lead">
									{session.busy && !stopping ? (
										<span className="starburst" />
									) : (
										<span
											className={`dot ${session.exited ? "tone-muted" : stopping ? "tone-pending" : "tone-success"}`}
										/>
									)}
								</span>
								<span className="side-label">
									{sessionTitle(session, isChat(session.cwd), savedName(session))}
								</span>
								{stopping ? (
									<span className="side-meta">Ending…</span>
								) : session.exited ? (
									acting.has(session.id) ? (
										<span className="side-meta">Dismissing…</span>
									) : (
										<button
											type="button"
											className="side-stop side-dismiss"
											title="Dismiss: take this ended session off the list"
											aria-label="Dismiss"
											onClick={event => {
												event.stopPropagation();
												void dismissLive(session.id);
											}}
										>
											<Icon name="close" size={11} />
										</button>
									)
								) : (
									<button
										type="button"
										className="side-stop"
										title="End this session"
										onClick={event => {
											event.stopPropagation();
											void stopSession(session.id);
										}}
									>
										<Icon name="square" size={11} />
									</button>
								)}
							</div>
						);
					})}
					{pinnedSessions.length ? <div className="side-title">Pinned</div> : null}
					{pinnedSessions.map(session => (
						<SavedItem
							key={session.id}
							className="recent pinned-row"
							session={session}
							lead={<Icon name="pin" size={13} />}
							where={projectNames.get(session.path) ?? "Chat"}
							cutOff={isCutOff(session)}
							spawning={spawning}
							onResume={() => void spawn([resumeRequest(session)])}
							onRestore={() => restoreSaved(session)}
							onPin={() => void pin(session)}
						/>
					))}
					<div className="side-title">On this Mac</div>
					{peers.filter(peer => !peer.guiId).length === 0 ? (
						<div className="side-empty">No other omp sessions</div>
					) : null}
					{peers
						.filter(peer => !peer.guiId)
						.map(peer => (
							<div
								key={`${peer.pid}-${peer.short}`}
								className="side-item peer"
								title={`${peer.cwd}\nagent://Main@${peer.short}${peer.accepts ? "" : "\n(editor session: listed, takes no messages)"}\nClick to copy the address`}
								onClick={() => {
									void navigator.clipboard?.writeText(`agent://Main@${peer.short}`);
									setCopied(peer.short);
									setTimeout(() => setCopied(value => (value === peer.short ? null : value)), 1500);
								}}
							>
								<span className="side-lead">
									{peer.busy ? (
										<span className="starburst" />
									) : (
										<span className={`dot ${peer.accepts ? "tone-muted" : "tone-pending"}`} />
									)}
								</span>
								<span className="side-label">
									{copied === peer.short
										? "Address copied"
										: plainTitle(peer.name ?? "") || basename(peer.cwd)}
								</span>
								<span className="side-mode">{peer.mode}</span>
							</div>
						))}
					<div className="side-title">Projects</div>
					{projects.length === 0 ? <div className="side-empty">No projects yet</div> : null}
					{sideProjects.map(project => (
						<div key={project.root} className="side-group">
							<div
								className={`side-item project ${active === null && !settingsOpen && target === project.root ? "active" : ""}`}
								title={`${tildePath(project.root, home)}\nNew session in this project`}
								onClick={() => newIn(project.root)}
							>
								<span className="side-lead">
									<Icon name="folder" size={13} />
								</span>
								<span className="side-label">{project.name}</span>
								<button
									type="button"
									className={`side-pin ${pinnedRoots.includes(project.root) ? "on" : ""}`}
									title={pinnedRoots.includes(project.root) ? "Unpin" : "Pin: keep it at the top of Projects"}
									aria-label={pinnedRoots.includes(project.root) ? "Unpin project" : "Pin project"}
									aria-pressed={pinnedRoots.includes(project.root)}
									onClick={event => {
										event.stopPropagation();
										toggleProjectPin(project.root);
									}}
								>
									<Icon name="pin" size={12} />
								</button>
								<span className="side-add">
									<Icon name="plus" size={13} />
								</span>
							</div>
							{listed(unpinned(project.sessions), 3).map(savedItem)}
						</div>
					))}
					<div
						className={`side-title side-title-action ${active === null && !target ? "active" : ""}`}
						title="New chat without a project"
						onClick={() => newIn("")}
					>
						<span>Chats</span>
						<Icon name="plus" size={12} />
					</div>
					{chats.length === 0 ? <div className="side-empty">No chats yet</div> : null}
					{listed(unpinned(chats), 8).map(savedItem)}
				</div>
				<div className="side-foot">
					<button
						type="button"
						className={`side-settings ${settingsOpen ? "active" : ""}`}
						onClick={() => setSettingsOpen(true)}
					>
						<Icon name="settings" size={14} /> Settings
					</button>
				</div>
			</aside>
			<main className="content">
				<ModelListContext.Provider value={modelList}>
					<Notices waiting={waiting} />
					{settingsOpen ? (
						<SettingsPage settings={{ appearance, instructions }} onClose={closeSettings} />
					) : activeConnection ? (
						<SessionHead
							key={activeConnection.id}
							connection={activeConnection}
							listed={live.find(item => item.id === activeConnection.id)}
							home={home}
							isChat={isChat}
							ending={ending.has(activeConnection.id)}
							saved={savedName}
							onEnd={() => void stopSession(activeConnection.id)}
						/>
					) : (
						<StartPage
							picker={
								<ProjectPicker
									target={target}
									projects={pickable}
									home={home}
									onPick={setTarget}
									onChoose={() => void chooseFolder()}
								/>
							}
							modelPicker={
								<>
									<ModelPicker value={model} list={modelList} onPick={setModel} />
									<EffortPicker value={thinking} model={model} list={modelList} onPick={setThinking} />
									<WorkDetailPicker value={workDetail} onPick={setWorkDetail} />
									<ApprovalPicker value={approvalMode} onPick={setApproval} />
								</>
							}
							interrupted={
								interrupted.length ? (
									<InterruptedList
										entries={interrupted}
										home={home}
										spawning={spawning}
										acting={acting}
										onRestore={entries => void spawn(entries.flatMap(entry => restoreRequest(entry) ?? []))}
										onDismiss={(entries, force) => void settleInterrupted(entries, "dismiss", force)}
										onEnd={entry => void settleInterrupted([entry], "end")}
										saved={savedOf}
									/>
								) : null
							}
							recent={recentForTarget}
							recentTitle={recentTitle}
							onPin={session => void pin(session)}
							spawning={spawning}
							isCutOff={isCutOff}
							onStart={prompt =>
								void spawn([
									{
										project: target || undefined,
										model: model || undefined,
										thinking: thinking || undefined,
										prompt: prompt.trim() || undefined,
									},
								])
							}
							onResume={session => void spawn([resumeRequest(session)])}
							onRestore={restoreSaved}
						/>
					)}
					{open.map(id => {
						const connection = connections.current.get(id);
						return connection ? (
							<SessionView
								key={id}
								connection={connection}
								active={id === active && !settingsOpen}
								spawning={spawning}
								// The server restores it as recorded: its session file, or its first message when omp wrote none.
								onRestore={() => void spawn([{ from: id }], id)}
							/>
						) : null;
					})}
				</ModelListContext.Provider>
			</main>
		</div>
	);
}
