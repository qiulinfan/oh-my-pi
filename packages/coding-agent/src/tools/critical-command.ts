/**
 * Shell commands flagged as safety critical for approval policy.
 *
 * A critical command needs the user's confirmation in every approval mode, `yolo` included, and is
 * refused where no user can answer (print mode, subagents, hosts without a prompt). The cost of a
 * false negative is data loss or a compromised host; a false positive costs one prompt, or a refusal
 * in a headless run. So every shape here must be virtually never legitimate in automation, and
 * ordinary cleanup (`rm -rf ./build`, `rm -rf node_modules`, `find . -name x -delete`, a deep
 * absolute path) must stay unflagged.
 *
 * Two layers: regexes over the raw command text, for shapes that span words (pipes into a shell,
 * process substitution, fork bombs, download-then-run), and a per-segment look at `rm` and `find`
 * after shell quote removal, for what they would delete.
 */
import * as path from "node:path";
import { tokenizeShellSegments } from "./shell-tokenize";

/** A POSIX-ish shell as a command word: `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`. */
const SHELL = String.raw`(?:ba|z|da|k|fi)?sh`;
/** A command that runs a fetched file: a shell or `source`/`.` (optionally under sudo), or `./file`. */
const RUNS_FILE = String.raw`(?:(?:sudo\s+(?:-\S+\s+)*)?(?:${SHELL}|source|\.)\s+(?:-\S+\s+)*["']?(?:\.\/)?|\.\/)`;
/** End of a file word. */
const WORD_END = String.raw`(?=$|[\s;&|)"'])`;

const CRITICAL_BASH_PATTERNS: readonly RegExp[] = [
	// `--no-preserve-root` defeats coreutils' own refusal to recurse on `/`, so it is critical
	// wherever it appears. What a plain recursive `rm` deletes is judged per segment below.
	/\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.
	/\b(?:chmod|chown)\s+-R\s+\S+\s+["']?(?:~|\$HOME|\$\{HOME\})["']?\/?(?:\s|$)/, // the home directory itself.

	// Fork bombs: a function that pipes itself into itself in the background, whatever its name
	// (`:(){ :|:& };:`, `bomb(){ bomb|bomb& };bomb`, `function f { f|f & }`).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,
	/(?:^|[\s;&|({])([^\s(){}|;&<>]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&/,
	/\bfunction\s+([^\s(){}|;&<>]+)\s*(?:\(\s*\))?\s*\{\s*\1\s*\|\s*\1\s*&/,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	// dd to a device. Write-only pseudo-device sinks (`of=/dev/null`, `/dev/stdout`, `/dev/fd/1`, …) are
	// excluded: they cannot destroy data, and `dd … of=/dev/null` is the standard read-throughput idiom.
	/\bdd\s+if=.+of=\/dev\/(?!(?:null|zero|stdout|stderr|tty|fd\/\d+)(?:[\s;&|)<>]|$))/i,
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,
	/\bwipefs\b/i,
	/\bdiskutil\s+(?:eraseDisk|eraseVolume|zeroDisk|randomDisk|secureErase|partitionDisk)\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute.
	// Piped into a shell, also through `sudo` or `env`: `curl … | sh`, `wget -qO- … | sudo bash`.
	new RegExp(
		String.raw`\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+(?:-\S+\s+)*|env\s+(?:\S+=\S*\s+)*)?${SHELL}\b`,
		"i",
	),
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	new RegExp(String.raw`(?:^|[\s;&|(])(?:${SHELL}|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b`, "i"),
	// A download's output run as code: `eval "$(curl …)"`, `bash -c "$(curl …)"`,
	// `python3 -c "$(wget -qO- …)"`, `bash <<< "$(curl …)"`.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,
	new RegExp(
		String.raw`\b(?:${SHELL}|python[\d.]*|perl|ruby|node|bun|deno)\s+(?:-\S+\s+)*-[a-zA-Z]*[ce]\s+["']?(?:\$\(|\x60)\s*(?:curl|wget|fetch)\b`,
		"i",
	),
	new RegExp(String.raw`\b${SHELL}\s+(?:-\S+\s+)*<<<\s*["']?(?:\$\(|\x60)\s*(?:curl|wget|fetch)\b`, "i"),
	// Downloaded to a file, then run: `wget -O x … && sh x`, `curl -o x …; bash x`,
	// `curl … > x.sh && sh x.sh`, `curl -fsSLo i.sh … && chmod +x i.sh && ./i.sh`.
	new RegExp(
		String.raw`\b(?:curl|wget)\b[^\n;&|]*?(?:\s-[a-zA-Z]*[oO]\s*|\s--output(?:-document)?(?:=|\s+)|\s*>\s*)(["']?)([^\s"';&|<>]+)\1[\s\S]*?(?:^|[\s;&|(])${RUNS_FILE}\2${WORD_END}`,
		"i",
	),
	// Saved under the URL's own file name (`wget …/i.sh`, `curl -O …/i.sh`), then run: `sh i.sh`, `./i.sh`.
	new RegExp(
		String.raw`\b(?:curl|wget)\b[^\n;&|]*?\/([\w.+-]+)${WORD_END}[\s\S]*?(?:^|[\s;&|(])${RUNS_FILE}\1${WORD_END}`,
		"i",
	),

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	/\bkill\s+-(?:9|KILL|SIGKILL)\s+-1\b/, // kill every process the user can signal.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
];

/** Words that run the command after them: `sudo rm …`, `env X=1 rm …`, `command rm …`. */
const COMMAND_WRAPPERS = new Set(["sudo", "doas", "command", "builtin", "exec", "nohup", "time", "env", "nice"]);
/** `sudo`/`doas` options that take the next word as their value. */
const WRAPPER_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-n"]);

/** Temporary-file roots: a recursive delete below one of these is never critical. */
const TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/tmp/", "/var/folders/", "/private/var/folders/", "/dev/shm/"];

/** The command a segment runs and its arguments, past leading assignments and wrapper words. */
function commandOf(words: readonly string[]): { name: string; args: string[] } | undefined {
	let i = 0;
	while (i < words.length) {
		const word = words[i]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			i++;
			continue;
		}
		if (!COMMAND_WRAPPERS.has(path.posix.basename(word))) break;
		i++;
		while (i < words.length && words[i]!.startsWith("-")) {
			i += WRAPPER_VALUE_OPTIONS.has(words[i]!) ? 2 : 1;
		}
	}
	const head = words[i];
	return head === undefined ? undefined : { name: path.posix.basename(head), args: words.slice(i + 1) };
}

/** The home directory itself: `~`, `~user`, `$HOME`, `${HOME}`, with an optional `/`, `/*`, or `/.*`. */
function isHomeRoot(target: string): boolean {
	return /^(?:~[\w.-]*|\$HOME|\$\{HOME\})(?:\/+(?:\*|\.\*)?)?$/.test(target);
}

/**
 * An absolute path a recursive delete must not reach without the user: the root, a top-level
 * directory (`/usr`, `/Users`), or anything two levels down (`/Users/me`, `/usr/local`) other than
 * an entry of a temporary root. Deeper paths (`/Users/me/proj/build`) are ordinary.
 */
function isCriticalAbsoluteTarget(target: string): boolean {
	if (!target.startsWith("/")) return false;
	const normalized = path.posix
		.normalize(target)
		.replace(/\/(?:\*|\.\*)$/, "")
		.replace(/\/+$/, "");
	if (normalized === "" || normalized === "/") return true;
	if (TEMP_ROOTS.some(root => `${normalized}/`.startsWith(root) && `${normalized}/` !== root)) return false;
	return normalized.split("/").filter(Boolean).length <= 2;
}

/** Everything in the working directory or above it: `*`, `.`, `./*`, `.*`, `..`, `../*`. */
function isWorkingDirectoryWide(target: string): boolean {
	const relative = target.replace(/\/+$/, "").replace(/^(?:\.\/+)+/, "") || ".";
	return /^(?:\*|\.\*|\.\.?(?:\/+\.\.)*(?:\/+(?:\*|\.\*))?)$/.test(relative);
}

function isCriticalRm(args: readonly string[]): boolean {
	let recursive = false;
	let optionsEnded = false;
	const targets: string[] = [];
	for (const arg of args) {
		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
		} else if (!optionsEnded && arg.startsWith("--")) {
			if (arg === "--recursive") recursive = true;
		} else if (!optionsEnded && arg.length > 1 && arg.startsWith("-")) {
			if (/[rR]/.test(arg.slice(1))) recursive = true;
		} else {
			targets.push(arg);
		}
	}
	return (
		recursive &&
		targets.some(target => isHomeRoot(target) || isWorkingDirectoryWide(target) || isCriticalAbsoluteTarget(target))
	);
}

/** `find` rooted at `/`, a top-level directory, or the home directory, that deletes what it finds. */
function isCriticalFind(args: readonly string[]): boolean {
	const starts: string[] = [];
	let i = 0;
	while (i < args.length && /^-[HLP]$/.test(args[i]!)) i++;
	for (; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith("-") || arg === "(" || arg === "!") break;
		starts.push(arg);
	}
	const deletes = args.some(
		(arg, index) =>
			arg === "-delete" ||
			(/^-(?:exec|execdir|ok|okdir)$/.test(arg) && path.posix.basename(args[index + 1] ?? "") === "rm"),
	);
	return deletes && starts.some(start => isHomeRoot(start) || isCriticalAbsoluteTarget(start));
}

function isCriticalSegment(words: readonly string[]): boolean {
	const command = commandOf(words);
	if (!command) return false;
	if (command.name === "rm") return isCriticalRm(command.args);
	if (command.name === "find") return isCriticalFind(command.args);
	return false;
}

/**
 * Whether a shell command is safety critical: it wipes the filesystem root, a top-level or home
 * directory, or everything in the working directory; formats or overwrites a disk; runs code it
 * downloads; forks without bound; or similar.
 */
export function isCriticalShellCommand(command: string): boolean {
	if (command.trim() === "") return false;
	if (CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command))) return true;
	return tokenizeShellSegments(command).some(isCriticalSegment);
}
