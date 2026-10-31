/**
 * omp desktop: a native window onto this machine's `omp gui` server.
 *
 * The shell holds no GUI logic. It finds the owner's omp, runs
 * `omp gui --no-open --json --exit-on-stdin-close` with the login shell's
 * environment (which attaches to the running server or starts one), and loads
 * the server's page, so a browser tab and this window show the same live
 * sessions and every GUI change lands in both. A server this app started stops
 * when the app quits, or dies with it, since its stdin is a pipe from this
 * process; one started elsewhere keeps running.
 *
 * Supervision: one connect at a time, whatever asks for it; a liveness ping
 * every 5 s; a server this app started that dies on its own gets a crash log
 * and is restarted, at most twice a minute; past that, or when a server cannot
 * be started, one Retry / Quit / Show log dialog. supervisor.ts holds the
 * parts that need no Electron.
 *
 * Electron runs this file under Node, not Bun, so it uses node: APIs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	app,
	BrowserWindow,
	dialog,
	type MessageBoxOptions,
	type MessageBoxReturnValue,
	nativeTheme,
	powerMonitor,
	shell,
} from "electron";
import { type LoginShellEnv, readLoginShellEnv } from "./login-shell";
import {
	Budget,
	countLive,
	describeExit,
	type ExitStatus,
	fetchLive,
	findOmp,
	type GuiAddress,
	GuiProcess,
	type LiveSession,
	pingGui,
	quitQuestion,
	redact,
	writeCrashLog,
} from "./supervisor";

interface Connection extends GuiAddress {
	/** The server run this app connected to; undefined for a server too old to report it. */
	bootId?: string;
}

interface Recovery {
	message: string;
	detail: string;
	retryLabel?: string;
	/** Offer "Show log": the crash log when one was written, else the logs folder. */
	showLog: boolean;
	retry: () => void;
}

let window: BrowserWindow | null = null;
let loginShell!: Promise<LoginShellEnv>;
/** The `omp gui` process serving the connected server, when this app started it. */
let owned: GuiProcess | null = null;
/** The `omp gui` process of the connect in flight. */
let starting: GuiProcess | null = null;
let server: Connection | null = null;
/** What the window last loaded from the server, so a repeated connect does not reload a working page. */
let shown: { win: BrowserWindow; url: string; bootId?: string } | null = null;
/** The last /api/live answer, for a crash log. */
let lastLive: { pid: number; at: Date; sessions: LiveSession[] } | null = null;
let connecting: Promise<void> | null = null;
/** A trigger arrived during the connect in flight: run it once more afterwards. */
let again = false;
/** The next connect first stops this app's server (a restart the user asked for). */
let restartRequested = false;
let quitDecision: Promise<boolean> | null = null;
/** Quitting is approved and under way: the stop is running, and nothing restarts. */
let quitting = false;
let quitApproved = false;
/** The system is logging out or shutting down: quit without asking. */
let sessionEnding = false;
let recoveryOpen = false;
let recoveryLog: string | undefined;
/** Consecutive liveness pings that found the server gone. */
let gone = 0;
let probing = false;
let livenessTimer: NodeJS.Timeout | undefined;
/** Aborted when quitting: a window with a sheet attached does not close, and the quit stalls on it. */
const closeSheets = new AbortController();
const serverRestarts = new Budget(2, 60_000);
/** Server runs already offered a restart after a reinstall. */
const offeredRestart = new Set<string>();

/** A passive page for the window while there is no server page to show. */
function statusPage(text: string): string {
	const html = `<!doctype html><meta charset="utf-8"><title>omp</title><style>
:root { color-scheme: light dark; }
html, body { margin: 0; height: 100%; background: #f3f3f0; color: #52514e; font: 13px -apple-system, system-ui, sans-serif; }
body { display: grid; place-items: center; -webkit-app-region: drag; -webkit-user-select: none; cursor: default; }
@media (prefers-color-scheme: dark) { html, body { background: #111111; color: #b0afa5; } }
</style><body>${text}</body>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showStatus(win: BrowserWindow, text: string): void {
	if (win.isDestroyed()) return;
	if (shown?.win === win) shown = null;
	// A load of the server page started after this one aborts it.
	win.loadURL(statusPage(text)).catch(() => {});
}

function pageUrl(conn: Connection, env: LoginShellEnv): string {
	// Only a server this app started inherited the environment the failed read left it with.
	const degraded = env.failure !== undefined && !conn.attached;
	return `${conn.url}&shell=desktop${degraded ? "&env=degraded" : ""}`;
}

/** A sheet on the window when it is visible, else an app-modal box. */
function messageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
	const parent = window && !window.isDestroyed() && window.isVisible() ? window : null;
	return parent
		? dialog.showMessageBox(parent, { ...options, signal: closeSheets.signal })
		: dialog.showMessageBox(options);
}

/**
 * The one recovery dialog. A failure while it is open opens no other; it only
 * becomes the log "Show log" opens. Every button leads somewhere: Retry, Quit,
 * or the log and back to the dialog.
 */
function recover(problem: Recovery): void {
	if (quitting || recoveryOpen) return;
	recoveryOpen = true;
	void (async () => {
		try {
			for (;;) {
				const buttons = [problem.retryLabel ?? "Retry", "Quit", ...(problem.showLog ? ["Show log"] : [])];
				const { response } = await messageBox({
					type: "error",
					message: problem.message,
					detail: problem.detail,
					buttons,
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				});
				if (quitting) return;
				if (response === 2) {
					if (recoveryLog) shell.showItemInFolder(recoveryLog);
					else void shell.openPath(app.getPath("logs"));
					continue;
				}
				recoveryOpen = false;
				if (response === 1) app.quit();
				else problem.retry();
				return;
			}
		} finally {
			recoveryOpen = false;
		}
	})();
}

function retryServer(): void {
	serverRestarts.reset();
	void reconnect("retry");
}

async function crashLog(proc: GuiProcess, reason: string, conn: Connection | null): Promise<string | undefined> {
	const env = await loginShell;
	const pid = conn?.pid ?? proc.pid;
	const file = await writeCrashLog(app.getPath("logs"), {
		time: new Date(),
		reason,
		omp: proc.omp,
		pid,
		port: conn?.port,
		token: conn?.token,
		loginShell: env.failure ? `${env.shell} (could not be read: ${env.failure})` : env.shell,
		live: lastLive && lastLive.pid === pid ? lastLive : null,
		stderr: proc.stderr.text,
	});
	if (file) recoveryLog = file;
	else console.warn("omp desktop: the crash log could not be written");
	return file;
}

function redactedLines(proc: GuiProcess, token: string | undefined): string {
	return redact(proc.stderr.lastLines(8), token);
}

/** A connect that failed: a crash log when a child was involved, the status page, then the recovery dialog. */
async function failed(err: unknown, proc?: GuiProcess, conn: Connection | null = null): Promise<void> {
	// A failed page load's message quotes the page URL, token included.
	const message = redact(err instanceof Error ? err.message : String(err), conn?.token);
	console.warn(`omp desktop: ${message}`);
	const log = proc ? await crashLog(proc, `could not connect: ${message}`, conn) : undefined;
	if (quitting) return;
	if (window) showStatus(window, "omp is not connected to its GUI server");
	recover({
		message: "omp could not start its GUI server",
		detail: [message, proc && redactedLines(proc, conn?.token), log && `Crash log: ${log}`]
			.filter(Boolean)
			.join("\n\n"),
		showLog: true,
		retry: retryServer,
	});
}

/**
 * The server this app started does not answer in time, and the window has no
 * page of it. Busy or wedged is not dead: it is never stopped behind the
 * user's back, and quitting stops it. No crash log, since nothing exited.
 */
function notResponding(conn: Connection, proc: GuiProcess): void {
	console.warn(`omp desktop: the GUI server (pid ${conn.pid}) is not responding`);
	if (window) showStatus(window, "omp's GUI server is not responding");
	recover({
		message: "The omp GUI server is not responding",
		detail: [
			`It (pid ${conn.pid}) did not answer in time. Its sessions keep running; Retry checks again, and quitting stops it.`,
			redactedLines(proc, conn.token),
		]
			.filter(Boolean)
			.join("\n\n"),
		showLog: false,
		retry: retryServer,
	});
}

/** The server this app started exited. Unless that was asked for, log it and restart it, within the budget. */
function onOwnedExit(proc: GuiProcess, status: ExitStatus): void {
	if (owned !== proc) return;
	owned = null;
	const conn = server;
	server = null;
	if (quitting || proc.expected) return;
	console.warn(`omp desktop: the GUI server (pid ${proc.pid}) ${describeExit(status)}`);
	void (async () => {
		const log = await crashLog(proc, `the GUI server ${describeExit(status)}`, conn);
		// A pending quit question or an open recovery dialog decides first, without spending a restart:
		// cancelling the question reconnects, and every recovery button reconnects or quits.
		if (quitting || quitDecision || recoveryOpen) return;
		if (serverRestarts.take()) {
			void reconnect("server exited");
			return;
		}
		recover({
			message: "The omp GUI server keeps stopping",
			detail: [
				`It ${describeExit(status)}, after being restarted twice in the last minute.`,
				redactedLines(proc, conn?.token),
				log && `Crash log: ${log}`,
			]
				.filter(Boolean)
				.join("\n\n"),
			showLog: true,
			retry: retryServer,
		});
	})();
}

/**
 * Whether `win` shows this page of this server run: loaded, not failed since,
 * and its renderer not crashed (a crash the window did not reload leaves it
 * blank until a connect loads the page again).
 */
function shows(win: BrowserWindow | null, url: string, bootId: string | undefined): boolean {
	return (
		!!win &&
		!win.isDestroyed() &&
		shown?.win === win &&
		shown.url === url &&
		shown.bootId === bootId &&
		!win.webContents.isCrashed()
	);
}

async function showServer(conn: Connection, env: LoginShellEnv, proc?: GuiProcess): Promise<void> {
	const win = window;
	if (!win || win.isDestroyed()) return;
	const url = pageUrl(conn, env);
	if (shows(win, url, conn.bootId)) return;
	try {
		await win.loadURL(url);
		shown = { win, url, bootId: conn.bootId };
	} catch (err) {
		// Superseded by another load (the page reloading itself), or the window went away. The abort of
		// the status page this load replaces can reject it too, with errno -3 and an empty code.
		const { code, errno } = err as { code?: unknown; errno?: unknown };
		if (quitting || win.isDestroyed() || code === "ERR_ABORTED" || errno === -3) return;
		await failed(err, proc, conn);
	}
}

/**
 * Bring the window onto a working server. A server that still answers is
 * kept, so a reconnect never ends live sessions. Otherwise a server this app
 * started that no longer serves is stopped first, and one `omp gui` attaches
 * to the running server or starts one.
 */
async function connectOnce(): Promise<void> {
	const env = await loginShell;
	if (quitting) return;
	if (restartRequested) {
		restartRequested = false;
		server = null;
		await owned?.stop();
	}
	if (server) {
		const ping = await pingGui(server, server);
		if (quitting) return;
		if (ping.state === "ok") return showServer(server, env, owned ?? undefined);
		if (ping.state === "slow") {
			// A timeout alone is not gone: a window showing the server keeps its page, and liveness catches a real death.
			// With no window there is nothing to bring onto it; a new window reconnects.
			if (!window || shows(window, pageUrl(server, env), server.bootId)) return;
			if (owned?.alive) return notResponding(server, owned);
		}
		server = null;
	}
	if (owned?.alive) await owned.stop();
	// A quit approved during that stop has stopped everything it saw; a child spawned now would start a server after the app is gone.
	if (quitting) return;

	const named = process.env.OMP_DESKTOP_OMP;
	let omp: string;
	try {
		omp = await findOmp(named, env.env.PATH, os.homedir());
	} catch (err) {
		// Only the PATH search depends on the login shell's environment.
		const why = env.failure && !named ? ` (The login shell's environment could not be read: ${env.failure}.)` : "";
		return failed(new Error(`${err instanceof Error ? err.message : String(err)}${why}`));
	}
	if (quitting) return;
	const proc = new GuiProcess(omp, env.env, { cwd: os.homedir() });
	starting = proc;
	let address: GuiAddress;
	try {
		address = await proc.ready();
	} catch (err) {
		if (!quitting) await failed(err, proc);
		return;
	} finally {
		if (starting === proc) starting = null;
	}
	if (quitting) {
		await proc.stop();
		return;
	}
	if (!address.attached) {
		owned = proc;
		void proc.exited.then(status => onOwnedExit(proc, status));
	}
	const ping = await pingGui(address, null);
	const conn: Connection = { ...address, bootId: ping.state === "ok" ? ping.bootId : undefined };
	server = conn;
	gone = 0;
	console.info(`omp desktop: ${address.attached ? "attached to" : "started"} the GUI server (pid ${address.pid})`);
	await showServer(conn, env, address.attached ? undefined : proc);
	if (ping.state === "ok" && ping.replaced) void offerRestart(conn);
}

/**
 * Every trigger goes through here: startup, an owned server's unexpected exit,
 * a failed page load, liveness, a new window, Retry, a restart after a
 * reinstall. They share one attempt, so two `omp gui` never run at once; a
 * trigger that arrives during it runs it once more afterwards, so a server
 * that dies mid-connect is not missed.
 */
function reconnect(reason: string): Promise<void> {
	if (quitting || quitDecision || recoveryOpen) return Promise.resolve();
	if (connecting) {
		again = true;
		return connecting;
	}
	console.info(`omp desktop: connecting (${reason})`);
	connecting = (async () => {
		try {
			do {
				again = false;
				await connectOnce();
			} while (again && !quitting && !recoveryOpen);
		} finally {
			connecting = null;
		}
	})();
	return connecting;
}

/** Every 5 s: is the connected server still the run this window talks to? Two "gone" in a row reconnect. */
async function checkLiveness(): Promise<void> {
	const conn = server;
	if (!conn || probing || connecting || quitting || quitDecision || recoveryOpen) return;
	probing = true;
	try {
		const ping = await pingGui(conn, conn);
		if (server !== conn) return;
		if (ping.state !== "gone") gone = 0;
		if (ping.state === "ok") {
			if (ping.replaced) void offerRestart(conn);
			const sessions = await fetchLive(conn, 1_500);
			if (sessions && server === conn) lastLive = { pid: conn.pid, at: new Date(), sessions };
			return;
		}
		if (ping.state === "gone" && ++gone >= 2) {
			gone = 0;
			console.info(`omp desktop: the GUI server (pid ${conn.pid}) is gone: ${ping.why}`);
			void reconnect("server gone");
		}
	} finally {
		probing = false;
	}
}

/** omp was reinstalled under a server this app started: offer, once per server run, to restart it onto the new build. */
async function offerRestart(conn: Connection): Promise<void> {
	const key = conn.bootId ?? String(conn.pid);
	if (conn.attached || !owned?.alive || offeredRestart.has(key)) return;
	offeredRestart.add(key);
	const inspection = countLive(await fetchLive(conn));
	let detail: string;
	if (inspection === "unknown") detail = "This ends every session it hosts; you can restore them.";
	else if (inspection.live === 0) detail = "No sessions are running.";
	else if (inspection.live === 1) detail = "This ends 1 session; you can restore it.";
	else detail = `This ends ${inspection.live} sessions; you can restore them.`;
	const { response } = await messageBox({
		type: "question",
		message: "omp was reinstalled. Restart the GUI server now?",
		detail,
		buttons: ["Restart", "Later"],
		defaultId: 0,
		cancelId: 1,
		noLink: true,
	});
	if (response !== 0 || quitting || server !== conn || !owned?.alive) return;
	restartRequested = true;
	void reconnect("restart after reinstall");
}

/** Whether quitting may go ahead. It asks only when this app's server hosts sessions, or when it cannot tell. */
async function decideQuit(): Promise<boolean> {
	if (!owned?.alive || sessionEnding) return true;
	const inspection = server ? countLive(await fetchLive(server)) : "unknown";
	if (sessionEnding) return true;
	const question = quitQuestion(inspection);
	if (!question) return true;
	// No parent: the question shows even with every window closed.
	const { response } = await dialog.showMessageBox({
		type: "warning",
		...question,
		buttons: ["Quit", "Cancel"],
		defaultId: 0,
		cancelId: 1,
		noLink: true,
	});
	return response === 0;
}

async function requestQuit(): Promise<void> {
	// A repeated Cmd+Q joins the question already open.
	if (quitDecision) {
		console.info("omp desktop: quit requested again; the quit question is already open");
		app.focus({ steal: true });
		return;
	}
	quitDecision = decideQuit();
	let approved = false;
	try {
		approved = await quitDecision;
	} finally {
		quitDecision = null;
	}
	if (approved) return finishQuit();
	// A server that died while the question was open was not restarted then.
	void reconnect("quit cancelled");
}

async function finishQuit(): Promise<void> {
	quitting = true;
	if (owned || starting) console.info("omp desktop: quitting; stopping the GUI server this app started");
	clearInterval(livenessTimer);
	closeSheets.abort();
	for (const win of BrowserWindow.getAllWindows()) win.hide();
	await Promise.all([owned?.stop(), starting?.stop()]);
	quitApproved = true;
	app.quit();
	// The server is stopped; nothing left may keep the app from exiting.
	setTimeout(() => app.exit(0), 3_000);
}

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1320,
		height: 860,
		minWidth: 760,
		minHeight: 520,
		title: "omp",
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 16, y: 17 },
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f3f3f0",
		show: true,
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			// An unfocused or covered window keeps painting a streaming turn as it arrives, instead of
			// holding its frames and timers back and showing the whole stretch at once when it comes to the front.
			// The cost is CPU while the window is out of sight and omp is streaming; an idle session paints nothing.
			backgroundThrottling: false,
		},
	});
	showStatus(win, "Starting omp…");
	// Links leave the app for the default browser; the window only ever shows the GUI server.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, target) => {
		if (server && new URL(target).origin === new URL(server.url).origin) return;
		event.preventDefault();
		if (/^https?:/.test(target)) void shell.openExternal(target);
	});
	// The server went away under the page (it reloaded onto a stopped server): reconnect.
	win.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
		if (!isMainFrame || code === -3 || url.startsWith("data:")) return;
		if (shown?.win === win) shown = null;
		// The connect in flight sees its own load fail.
		if (connecting || quitting) return;
		void reconnect("page failed to load");
	});
	// Sessions live in the server, so a reload loses only which session was open.
	const crashes = new Budget(3, 60_000);
	let killedOnPurpose = false;
	win.webContents.on("render-process-gone", (_event, details) => {
		if (quitting || win.isDestroyed() || details.reason === "clean-exit") return;
		if (killedOnPurpose) {
			killedOnPurpose = false;
			return;
		}
		if (crashes.take()) {
			console.info(`omp desktop: the window's page stopped (${details.reason}); reloading it`);
			win.webContents.reload();
			return;
		}
		recover({
			message: "The omp window keeps crashing",
			detail: `Its page stopped (${details.reason}) more than 3 times in a minute. The sessions keep running in the GUI server.`,
			retryLabel: "Reload",
			showLog: false,
			retry: () => {
				crashes.reset();
				if (!win.isDestroyed()) win.webContents.reload();
			},
		});
	});
	let askingUnresponsive = false;
	win.on("unresponsive", () => {
		if (askingUnresponsive || quitting) return;
		askingUnresponsive = true;
		void dialog
			.showMessageBox(win, {
				signal: closeSheets.signal,
				type: "warning",
				message: "The omp window is not responding",
				detail: "The sessions keep running in the GUI server; reloading the window reconnects to them.",
				buttons: ["Wait", "Reload"],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			})
			.then(({ response }) => {
				askingUnresponsive = false;
				if (response !== 1 || win.isDestroyed()) return;
				killedOnPurpose = true;
				win.webContents.forcefullyCrashRenderer();
				win.webContents.reload();
			});
	});
	win.on("show", () => {
		sessionEnding = false;
	});
	win.on("closed", () => {
		if (window === win) window = null;
		if (shown?.win === win) shown = null;
	});
	return win;
}

/**
 * `OMP_DESKTOP_DATA_DIR` (development and test runs): keep Electron's data
 * and this app's logs, crash logs included, under that directory instead of
 * ~/Library. It also holds the single-instance lock, so such a run never hands
 * itself to another instance. It does not choose the GUI server;
 * OMP_DESKTOP_OMP does. False when the value cannot be used.
 */
function useDataDir(dir: string | undefined): boolean {
	if (!dir) {
		app.setAppLogsPath();
		return true;
	}
	if (!path.isAbsolute(dir)) {
		console.error(`omp desktop: OMP_DESKTOP_DATA_DIR must be an absolute path: ${dir}`);
		return false;
	}
	try {
		const userData = path.join(dir, "data");
		const logs = path.join(dir, "logs");
		for (const folder of [userData, logs]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		app.setPath("userData", userData);
		app.setAppLogsPath(logs);
		return true;
	} catch (err) {
		console.error(`omp desktop: cannot use OMP_DESKTOP_DATA_DIR ${dir}: ${String(err)}`);
		return false;
	}
}

/** activate and second-instance: bring back the window, or make a new one and connect it. */
function reveal(): void {
	if (quitting) return;
	if (!window || window.isDestroyed()) {
		window = createWindow();
		void reconnect("new window");
		return;
	}
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

// Before the single-instance lock, which lives in the data directory.
if (!useDataDir(process.env.OMP_DESKTOP_DATA_DIR)) {
	app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	// Read in parallel with the window; the server spawn awaits it.
	const probe = new AbortController();
	loginShell = readLoginShellEnv({ signal: probe.signal }).then(result => {
		if (result.failure) console.warn(`omp desktop: reading ${result.shell}'s environment failed: ${result.failure}`);
		return result;
	});
	app.on("will-quit", () => probe.abort());

	app.whenReady().then(() => {
		window = createWindow();
		app.on("activate", (_event, hasVisibleWindows) => {
			sessionEnding = false;
			if (!hasVisibleWindows) reveal();
		});
		app.on("second-instance", reveal);
		app.on("browser-window-focus", () => {
			sessionEnding = false;
		});
		powerMonitor.on("shutdown", () => {
			sessionEnding = true;
		});
		livenessTimer = setInterval(() => void checkLiveness(), 5_000);
		void reconnect("startup");
	});

	// macOS keeps the app (and the server it owns) alive with no window, as other Mac apps do.
	// A quit that a closing window cancelled is resumed once the windows are gone.
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin" || quitApproved) app.quit();
	});

	app.on("before-quit", event => {
		if (quitApproved) return;
		event.preventDefault();
		// Already stopping the server; app.quit() follows it.
		if (quitting) return;
		void requestQuit();
	});
}
