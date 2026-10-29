/**
 * The login shell's environment. An app opened from the Dock gets launchd's
 * bare environment (PATH is /usr/bin:/bin:...), while omp and the commands its
 * sessions run need the one the user's shell sets up, so read it once, as
 * editors do.
 *
 * Ported from DeepSeek Harness's readShell: the shell runs as an interactive
 * login shell in its own process group, with stdin closed so an rc prompt
 * reads EOF instead of waiting. Its output is framed by NUL delimiters, and
 * the read completes at the closing delimiter rather than when stdout closes,
 * so a background job an rc file starts cannot stall it. A shell that does not
 * finish in time is killed with its whole process group.
 *
 * No electron import, so bun test can load it.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import * as os from "node:os";
import type { Readable } from "node:stream";

const DELIMITER = "_OMP_DESKTOP_ENV_DELIMITER_";
const MARKER = Buffer.from(`\0${DELIMITER}\0`);
/** Plain enough for sh, bash, zsh and fish alike. */
const DUMP = `printf '\\0%s\\0' '${DELIMITER}'; command env -0 || exit; printf '\\0%s\\0' '${DELIMITER}'; exit`;
/** Keep oh-my-zsh update prompts and tmux autostart plugins from blocking a read with no terminal. */
const PROBE_ENV = { DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true", ZSH_TMUX_AUTOSTART: "false" };
/** Variables that describe a shell process rather than the user's configuration. */
const SESSION_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_", ...Object.keys(PROBE_ENV)]);

export interface LoginShellEnv {
	/** `base` overlaid with the shell's variables, or `base` alone when the read failed; never the probe's own PWD, SHLVL or _. */
	env: NodeJS.ProcessEnv;
	shell: string;
	/** Why the read failed: `timeout`, `aborted`, `exit N`, a signal name, a spawn error or `unparsed`. Never shell output, which holds credentials. */
	failure?: string;
}

export interface LoginShellOptions {
	/** The environment to overlay; defaults to this process's. */
	base?: NodeJS.ProcessEnv;
	/** Defaults to {@link accountShell}. */
	shell?: string;
	/** Defaults to the home directory. */
	cwd?: string;
	/** Defaults to 10 s. */
	timeoutMs?: number;
	/** Aborting kills the shell's process group. */
	signal?: AbortSignal;
}

/** The account's login shell (what the Dock would start), then $SHELL, then /bin/zsh. */
export function accountShell(): string {
	try {
		const shell = os.userInfo().shell;
		if (shell) return shell;
	} catch {}
	return process.env.SHELL || "/bin/zsh";
}

/** The variables printed between the dump's two delimiters, or undefined when both are not there. */
export function parseEnvDump(stdout: string): Record<string, string> | undefined {
	const parts = stdout.split("\0");
	const first = parts.indexOf(DELIMITER);
	const last = parts.lastIndexOf(DELIMITER);
	if (first === -1 || first === last) return undefined;
	const vars: Record<string, string> = {};
	for (const entry of parts.slice(first + 1, last)) {
		const eq = entry.indexOf("=");
		if (eq > 0) vars[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return vars;
}

function withoutSessionKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) if (!SESSION_KEYS.has(key)) out[key] = value;
	return out;
}

function readShell(
	shell: string,
	base: NodeJS.ProcessEnv,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<Record<string, string> | string> {
	const { promise, resolve } = Promise.withResolvers<Record<string, string> | string>();
	if (signal?.aborted) {
		resolve("aborted");
		return promise;
	}
	let child: ChildProcessByStdio<null, Readable, null>;
	try {
		child = spawnShell(shell, base, cwd);
	} catch (err) {
		resolve(err instanceof Error ? err.message : String(err));
		return promise;
	}
	const chunks: Buffer[] = [];
	let tail = Buffer.alloc(0);
	let markers = 0;
	const output = () => parseEnvDump(Buffer.concat(chunks).toString("utf8")) ?? "unparsed";
	const onData = (chunk: Buffer) => {
		chunks.push(chunk);
		const window = Buffer.concat([tail, chunk]);
		for (let at = window.indexOf(MARKER); at !== -1; at = window.indexOf(MARKER, at + MARKER.length)) markers++;
		tail = window.subarray(Math.max(0, window.length - MARKER.length + 1));
		// rc-started background jobs inherit stdout and can hold it open long after the shell exits.
		if (markers >= 2) finish(output());
	};
	const killGroup = () => {
		try {
			process.kill(-(child.pid as number), "SIGKILL");
		} catch {}
	};
	// A killed group's strays can keep stdout open, so a stopped read resolves without waiting for close.
	const stop = (reason: "timeout" | "aborted") => {
		finish(reason);
		killGroup();
	};
	const onAbort = () => stop("aborted");
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	function finish(result: Record<string, string> | string): void {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		// Keep draining so rc-started children that write to stdout do not die of EPIPE.
		child.stdout.off("data", onData);
		child.stdout.resume();
		resolve(result);
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	child.stdout.on("data", onData);
	child.on("error", err => finish(err.message));
	child.on("close", (code, closeSignal) => {
		if (code !== 0) finish(closeSignal ?? `exit ${code}`);
		else finish(output());
	});
	return promise;
}

function spawnShell(shell: string, base: NodeJS.ProcessEnv, cwd: string): ChildProcessByStdio<null, Readable, null> {
	return spawn(shell, ["-ilc", DUMP], {
		cwd,
		env: { ...base, ...PROBE_ENV },
		stdio: ["ignore", "pipe", "ignore"],
		detached: true,
	});
}

/** Read the login shell's environment once. Never rejects: a failed read returns `base` and the reason. */
export async function readLoginShellEnv(options: LoginShellOptions = {}): Promise<LoginShellEnv> {
	const base = options.base ?? process.env;
	const shell = options.shell ?? accountShell();
	const result = await readShell(
		shell,
		base,
		options.cwd ?? os.homedir(),
		options.timeoutMs ?? 10_000,
		options.signal,
	);
	if (typeof result === "string") return { env: withoutSessionKeys(base), shell, failure: result };
	return { env: withoutSessionKeys({ ...base, ...result }), shell };
}
