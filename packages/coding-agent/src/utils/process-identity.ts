/**
 * Process identity across processes: a token for when the process wearing a pid started, so a pid
 * recorded earlier (an isolation sandbox's owner, a GUI-hosted session's omp) can be told apart from
 * an unrelated process that later reused it.
 */
import { $ } from "bun";

/** `ps` formats start times in the locale and time zone it runs in: pin both, so every reader gets one format. */
const PS_ENV = { LC_ALL: "C", TZ: "UTC0" };

/**
 * A token for the start time of the process wearing `pid`, or null when it is gone or the platform
 * cannot say. A pid still alive with the token recorded earlier is still that process, not a reused
 * pid, so callers compare tokens as exact strings.
 *
 * Linux reads `/proc/<pid>/stat` field 22 (start time in clock ticks since boot). Other Unixes run
 * `/bin/ps -o lstart` in the C locale and UTC, so a token one process recorded matches what another
 * reads whatever their locales and time zones. Windows reports neither and yields null.
 */
export async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "win32") return null;
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await Bun.file(`/proc/${pid}/stat`).text();
		} catch {
			return null;
		}
		// The comm field (2) may hold spaces and parens: field 22 is the 20th token after the last ')'.
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return null;
		const starttime = stat.slice(commEnd + 2).split(" ")[19];
		return starttime && starttime.length > 0 ? starttime : null;
	}
	const res = await $`/bin/ps -o lstart= -p ${pid}`.env(PS_ENV).quiet().nothrow();
	if (res.exitCode !== 0) return null;
	const started = res.text().trim();
	return started.length > 0 ? started : null;
}
