/**
 * The app shell, laid out like Claude Code's desktop app: a session sidebar
 * (the sessions this server hosts, saved sessions grouped by project and the
 * no-project chats, other omp sessions on this Mac) and one session at a time
 * beside it, under a header naming it. "New session" opens a start page whose
 * first message becomes omp's positional prompt; it runs in the chosen
 * project, or as a chat in its own empty directory. Keys typed outside the composer go to omp as pty
 * bytes, so every omp shortcut (Ctrl+S agent hub, Shift+Tab effort, Esc)
 * works as in a terminal.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./icons";
import { keyBytes } from "./keys";
import { N, OmpMark, SurfaceContext, type SurfaceContextValue, Transcript } from "./render";
import { SessionConnection, type SurfaceMeta } from "./session";

const TOKEN = new URLSearchParams(location.search).get("t") ?? "";
/** The transcript column (see --column): omp lays its rows out for this width, not the window's. */
const COLUMN_PX = 760;

async function api<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-gui-token": TOKEN, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = await response.json();
	if (!response.ok) throw new Error(json.error ?? response.statusText);
	return json as T;
}

function stored(key: string, fallback: string): string {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

function store(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {}
}

interface LiveSession {
	id: string;
	cwd: string;
	args: string[];
	startedAt: number;
	exited: boolean;
	title?: string;
	busy: boolean;
}

/** omp's terminal title is "<icon> <session title>" (or "π <dir>" before one exists): keep the words. */
function sessionTitle(session: LiveSession, chat: boolean): string {
	const title = session.title?.replace(/^[-\u{F0000}-\u{FFFFD}π\s]+/u, "").trim();
	// Before omp names it, a session reads as its directory; a chat's directory name means nothing.
	if (title && title !== "omp" && title !== basename(session.cwd)) return title;
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
}

interface SavedSession {
	id: string;
	path: string;
	cwd: string;
	title: string;
	prompt: string;
	modified: string;
}

interface Project {
	root: string;
	name: string;
	modified: string;
	sessions: SavedSession[];
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

type ThemeChoice = "system" | "light" | "dark";

function useAppearance(): {
	theme: ThemeChoice;
	setTheme: (theme: ThemeChoice) => void;
	prose: string;
	setProse: (prose: string) => void;
} {
	const [theme, setThemeState] = useState<ThemeChoice>(() => stored("omp-gui.theme", "system") as ThemeChoice);
	const [prose, setProseState] = useState(() => stored("omp-gui.prose", "sans"));
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
	return {
		theme,
		setTheme: value => {
			store("omp-gui.theme", value);
			setThemeState(value);
		},
		prose,
		setProse: value => {
			store("omp-gui.prose", value);
			setProseState(value);
		},
	};
}

function useSession(connection: SessionConnection): number {
	return useSyncExternalStore(
		listener => connection.subscribe(listener),
		() => connection.version,
	);
}

const NO_PALETTE: Record<string, string> = {};

function Surface({ connection, meta }: { connection: SessionConnection; meta: SurfaceMeta }): ReactNode {
	const surface = connection.surfaces.get(meta.id)!;
	// Spans may name omp palette tokens; the stylesheet gives every known token this GUI's colour.
	const palette = meta.palette?.dark ?? meta.palette?.light ?? NO_PALETTE;
	const ctx = useMemo<SurfaceContextValue>(
		() => ({ session: connection, store: surface.store, sf: meta.id, palette }),
		[connection, surface.store, meta.id, palette],
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

function SessionView({ connection, active }: { connection: SessionConnection; active: boolean }): ReactNode {
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
			if (target.closest("textarea, input, select")) return;
			const bytes = keyBytes(event.nativeEvent);
			if (bytes === null) return;
			event.preventDefault();
			connection.keys(bytes);
		},
		[connection],
	);

	const surfaces = [...connection.surfaces.values()].map(surface => surface.meta);
	const inline = surfaces.filter(meta => meta.mode === "inline");
	const screens = surfaces.filter(meta => meta.mode === "screen");
	return (
		<div
			className="session-view"
			ref={rootRef}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			style={{ display: active ? undefined : "none" }}
		>
			{!connection.connected && !connection.exited ? <div className="banner">Connecting…</div> : null}
			{connection.exited ? <div className="banner">This omp session has ended.</div> : null}
			{inline.length === 0 && !connection.exited ? <div className="banner">Starting omp…</div> : null}
			{inline.slice(-1).map(meta => (
				<Surface key={meta.id} connection={connection} meta={meta} />
			))}
			{screens.map(meta => (
				<Surface key={meta.id} connection={connection} meta={meta} />
			))}
		</div>
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
	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) setOpen(false);
		};
		addEventListener("mousedown", close);
		return () => removeEventListener("mousedown", close);
	}, [open]);
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

function StartPage({
	picker,
	model,
	setModel,
	recent,
	onStart,
	onResume,
}: {
	picker: ReactNode;
	model: string;
	setModel: (value: string) => void;
	recent: SavedSession[];
	onStart: (prompt: string) => void;
	onResume: (session: SavedSession) => void;
}): ReactNode {
	const [prompt, setPrompt] = useState("");
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
								start();
							}
						}}
						placeholder="Describe a task for omp, or start with an empty session"
						spellCheck={false}
					/>
					<div className="start-bar">
						{picker}
						<label className="field-chip model" title="Model (empty: omp's default)">
							<Icon name="cpu" size={14} />
							<input
								id="new-model"
								value={model}
								onChange={event => setModel(event.target.value)}
								spellCheck={false}
								placeholder="default model"
							/>
						</label>
						<button type="button" className="send-btn" onClick={start} title="Start session  ⏎">
							<Icon name="arrow-up" size={16} />
						</button>
					</div>
				</div>
				<div className="start-hint">Enter starts the session, Shift+Enter adds a line.</div>
				{recent.length ? (
					<div className="start-recent">
						<div className="side-title">Pick up where you left off</div>
						{recent.slice(0, 5).map(session => (
							<div
								key={session.id}
								className="side-item"
								onClick={() => onResume(session)}
								title={`${session.cwd}\n${session.prompt}`}
							>
								<span className="side-lead">
									<Icon name="history" size={13} />
								</span>
								<span className="side-label">{savedLabel(session)}</span>
								<span className="side-meta">{ago(session.modified)}</span>
							</div>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

function SavedItem({ session, onResume }: { session: SavedSession; onResume: () => void }): ReactNode {
	return (
		<div className="side-item recent" onClick={onResume} title={`${session.cwd}\n${session.prompt}`}>
			<span className="side-lead" />
			<span className="side-label">{savedLabel(session)}</span>
			<span className="side-meta">{ago(session.modified)}</span>
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
	const [target, setTargetState] = useState<Target>(() => stored("omp-gui.project", ""));
	const [chosen, setChosen] = useState<string | null>(null);
	const [model, setModel] = useState(() => stored("omp-gui.model", ""));
	const [error, setError] = useState<string | null>(null);
	const connections = useRef(new Map<string, SessionConnection>());
	const appearance = useAppearance();

	const refresh = useCallback(async () => {
		try {
			const data = await api<{
				live: LiveSession[];
				projects: Project[];
				chats: SavedSession[];
				chatsDir: string;
				home: string;
			}>("/api/sessions");
			setLive(data.live);
			setProjects(data.projects);
			setChats(data.chats);
			setChatsDir(data.chatsDir);
			setHome(data.home);
			setPeers(await api<PeerSession[]>("/api/peers"));
		} catch (err) {
			setError(String(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 5000);
		return () => clearInterval(timer);
	}, [refresh]);

	const show = (id: string) => {
		if (!connections.current.has(id)) connections.current.set(id, new SessionConnection(id, TOKEN));
		setOpen(list => (list.includes(id) ? list : [...list, id]));
		setActive(id);
	};

	const setTarget = (value: Target) => {
		store("omp-gui.project", value);
		setTargetState(value);
	};

	const chooseFolder = async () => {
		setError(null);
		try {
			const { path } = await api<{ path: string | null }>("/api/choose-folder", {});
			if (!path) return;
			setChosen(path);
			setTarget(path);
		} catch (err) {
			setError(String(err));
		}
	};

	const spawn = async (options: { resume?: SavedSession; prompt?: string }) => {
		setError(null);
		try {
			store("omp-gui.model", model);
			const { id } = await api<{ id: string }>("/api/spawn", {
				project: options.resume ? undefined : target || undefined,
				resume: options.resume ? { path: options.resume.path, cwd: options.resume.cwd } : undefined,
				model: model.trim() || undefined,
				prompt: options.prompt?.trim() || undefined,
			});
			await refresh();
			show(id);
		} catch (err) {
			setError(String(err));
		}
	};

	const stopSession = async (id: string) => {
		connections.current.get(id)?.close();
		connections.current.delete(id);
		await api("/api/kill", { id });
		setOpen(list => list.filter(item => item !== id));
		setActive(current => (current === id ? null : current));
		void refresh();
	};

	const current = live.find(item => item.id === active);
	const isChat = (cwd: string) => Boolean(chatsDir) && (cwd === chatsDir || cwd.startsWith(`${chatsDir}/`));
	// A folder just chosen (or remembered from last time) may have no saved session yet, so the store does not list it.
	const extra = [chosen, target].find(root => root && !projects.some(project => project.root === root));
	const pickable = extra
		? [{ root: extra, name: basename(extra), modified: "", sessions: [] }, ...projects]
		: projects;
	const recentForTarget = target ? (projects.find(project => project.root === target)?.sessions ?? []) : chats;
	const newIn = (value: Target) => {
		setTarget(value);
		setActive(null);
	};
	return (
		<div className="app">
			<aside className="sidebar">
				<div className="side-top">
					<div className="brand">
						<OmpMark size={22} />
						omp
					</div>
					<button
						type="button"
						className={`new-session ${active === null ? "active" : ""}`}
						onClick={() => setActive(null)}
					>
						<Icon name="plus" size={15} /> New session
					</button>
				</div>
				<div className="side-scroll">
					{error ? <div className="error-text">{error}</div> : null}
					<div className="side-title">Sessions</div>
					{live.length === 0 ? <div className="side-empty">Nothing running</div> : null}
					{live.map(session => (
						<div
							key={session.id}
							className={`side-item ${session.id === active ? "active" : ""}`}
							onClick={() => show(session.id)}
							title={session.cwd}
						>
							<span className="side-lead">
								{session.busy ? (
									<span className="starburst" />
								) : (
									<span className={`dot ${session.exited ? "tone-muted" : "tone-success"}`} />
								)}
							</span>
							<span className="side-label">{sessionTitle(session, isChat(session.cwd))}</span>
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
						</div>
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
					{projects.map(project => (
						<div key={project.root} className="side-group">
							<div
								className={`side-item project ${active === null && target === project.root ? "active" : ""}`}
								title={`${tildePath(project.root, home)}\nNew session in this project`}
								onClick={() => newIn(project.root)}
							>
								<span className="side-lead">
									<Icon name="folder" size={13} />
								</span>
								<span className="side-label">{project.name}</span>
								<span className="side-add">
									<Icon name="plus" size={13} />
								</span>
							</div>
							{project.sessions.slice(0, 3).map(session => (
								<SavedItem
									key={session.id}
									session={session}
									onResume={() => void spawn({ resume: session })}
								/>
							))}
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
					{chats.slice(0, 8).map(session => (
						<SavedItem key={session.id} session={session} onResume={() => void spawn({ resume: session })} />
					))}
				</div>
				<div className="side-foot">
					<div className="seg-toggle" role="radiogroup" aria-label="Theme">
						{(
							[
								["system", "monitor", "Match the system"],
								["light", "sun", "Light"],
								["dark", "moon", "Dark"],
							] as const
						).map(([value, icon, label]) => (
							<button
								key={value}
								type="button"
								className={appearance.theme === value ? "on" : ""}
								title={label}
								aria-label={label}
								onClick={() => appearance.setTheme(value)}
							>
								<Icon name={icon} size={13} />
							</button>
						))}
					</div>
					<span className="foot-spacer" />
					<div className="seg-toggle" role="radiogroup" aria-label="Reading font">
						<button
							type="button"
							className={appearance.prose === "sans" ? "on" : ""}
							title="Answers in sans"
							onClick={() => appearance.setProse("sans")}
						>
							Aa
						</button>
						<button
							type="button"
							className={`serif-aa ${appearance.prose === "serif" ? "on" : ""}`}
							title="Answers in serif"
							onClick={() => appearance.setProse("serif")}
						>
							Aa
						</button>
					</div>
				</div>
			</aside>
			<main className="content">
				{active !== null ? (
					<header className="session-head">
						<span className="head-title">{current ? sessionTitle(current, isChat(current.cwd)) : "Session"}</span>
						{current ? (
							<span className="head-path">{isChat(current.cwd) ? "Chat" : tildePath(current.cwd, home)}</span>
						) : null}
						{current?.busy ? (
							<span className="head-state">
								<span className="starburst" /> Working
							</span>
						) : null}
						<span className="head-spacer" />
						{current && !current.exited ? (
							<button type="button" className="ghost-btn danger" onClick={() => void stopSession(current.id)}>
								<Icon name="square" size={11} /> End session
							</button>
						) : null}
					</header>
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
						model={model}
						setModel={setModel}
						recent={recentForTarget}
						onStart={prompt => void spawn({ prompt })}
						onResume={session => void spawn({ resume: session })}
					/>
				)}
				{open.map(id => {
					const connection = connections.current.get(id);
					return connection ? <SessionView key={id} connection={connection} active={id === active} /> : null;
				})}
			</main>
		</div>
	);
}
