/**
 * Opening a local path a transcript links to (omp gui's `/api/open`): which file or folder the link names, and how
 * the OS opens it without ever running it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** What a viewer opens as it is; any other file opens as text, so a link never runs a script or an app. */
const VIEWABLE_FILE = /\.(?:pdf|png|jpe?g|gif|webp|heic|svg|bmp|tiff?|mp4|mov|m4v|webm|mp3|m4a|wav|flac)$/i;

/**
 * The local file or directory a transcript link names, or null when it names none that exists. A path that does not
 * exist as written may carry a `:line` or `:line:col` suffix (`src/a.ts:12`), which is dropped.
 */
export async function resolveLinkedPath(
	href: string,
	cwd: string | undefined,
): Promise<{ path: string; directory: boolean } | null> {
	let target: string;
	if (href.startsWith("file://")) {
		try {
			target = decodeURIComponent(new URL(href).pathname);
		} catch {
			return null;
		}
	} else {
		// A scheme (`https:`), but not a file name with a line (`a.ts:12`).
		if (href === "" || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(href) || href.startsWith("#")) return null;
		let raw = href;
		try {
			raw = decodeURIComponent(href);
		} catch {}
		raw = raw.replace(/^~(?=$|\/)/, os.homedir());
		if (!path.isAbsolute(raw) && cwd === undefined) return null;
		target = path.resolve(cwd ?? "/", raw);
	}
	for (const candidate of [target, target.replace(/:\d+(?::\d+)?$/, "")]) {
		const stat = await fs.promises.stat(candidate).catch(() => null);
		if (stat) return { path: candidate, directory: stat.isDirectory() };
	}
	return null;
}

/**
 * How the OS opens a linked path. On macOS a directory is revealed in Finder (an `.app` bundle is a directory, and
 * revealing never launches it), media and documents open in their viewer, and every other file opens in the default
 * text editor (`open -t`), never in the app that would run it (`.command`, `.sh`, `.workflow`).
 */
export function openCommand(file: string, directory: boolean): string[] {
	if (process.platform !== "darwin") return ["xdg-open", file];
	if (directory) return ["open", "-R", file];
	return VIEWABLE_FILE.test(file) ? ["open", file] : ["open", "-t", file];
}
