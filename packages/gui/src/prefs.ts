/**
 * The page's own preferences (theme, prose font, the start page's last picks, pinned projects),
 * kept by the GUI server rather than this browser's storage: the desktop app and the Obsidian
 * and VS Code side bars each have storage of their own, and should all show the same. They load
 * before the first render, and again whenever the page comes back into view, since another
 * window may have changed them meanwhile. The theme and font are also copied into this
 * browser's storage, which index.html reads to paint the first frame in them.
 */
import { useSyncExternalStore } from "react";
import { api } from "./api";
import { type GuiPrefKey, type GuiPrefs, pinnedProjectRoots } from "./kinds";

let prefs: GuiPrefs = {};
const listeners = new Set<() => void>();
/** Saves the server has not answered yet, by key: a load that lands meanwhile keeps this window's value. */
const saving = new Map<GuiPrefKey, number>();
/** What index.html reads before the page loads, so the first frame already has the chosen theme and font. */
const FIRST_PAINT: [GuiPrefKey, string][] = [
	["theme", "omp-gui.theme"],
	["prose", "omp-gui.prose"],
];

function replace(next: GuiPrefs): void {
	prefs = next;
	for (const [key, stored] of FIRST_PAINT) {
		try {
			const value = next[key];
			if (value) localStorage.setItem(stored, value);
			else localStorage.removeItem(stored);
		} catch {}
	}
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Read them from the server; a page that cannot reach it keeps what it has, the defaults at first. */
export async function loadPrefs(): Promise<void> {
	let loaded: GuiPrefs;
	try {
		loaded = await api<GuiPrefs>("/api/prefs");
	} catch {
		return;
	}
	const next = { ...loaded };
	for (const key of saving.keys()) {
		if (prefs[key] === undefined) delete next[key];
		else next[key] = prefs[key];
	}
	replace(next);
}

/**
 * Show `value` at once and save it; a refused save takes the server's value back, and so does a
 * finished one with `reload`, for a change the server merges into what it holds.
 */
function save(key: GuiPrefKey, value: string | undefined, request: () => Promise<unknown>, reload = false): void {
	const next = { ...prefs };
	if (value) next[key] = value;
	else delete next[key];
	replace(next);
	saving.set(key, (saving.get(key) ?? 0) + 1);
	const settle = () => {
		const left = (saving.get(key) ?? 1) - 1;
		if (left) saving.set(key, left);
		else saving.delete(key);
	};
	request().then(
		() => {
			settle();
			if (reload) void loadPrefs();
		},
		() => {
			settle();
			void loadPrefs();
		},
	);
}

export function setPref(key: GuiPrefKey, value: string): void {
	save(key, value, () => api("/api/prefs", { key, value }));
}

/** A preference and its setter; `fallback` stands in while it is unset. */
export function usePref(key: GuiPrefKey, fallback: string): [string, (value: string) => void] {
	const value = useSyncExternalStore(subscribe, () => prefs[key] || fallback);
	return [value, next => setPref(key, next)];
}

/** The pinned project roots, in the order pinned. */
export function usePinnedProjects(): string[] {
	const value = useSyncExternalStore(subscribe, () => prefs.pinnedProjects ?? "");
	return pinnedProjectRoots(value);
}

/**
 * Pin or unpin one project. The server changes its stored list, not this window's copy, so a pin
 * another window made meanwhile stays; the reload after it brings that pin here too.
 */
export function pinProject(root: string, pinned: boolean): void {
	const roots = pinnedProjectRoots(prefs.pinnedProjects).filter(item => item !== root);
	if (pinned) roots.push(root);
	save(
		"pinnedProjects",
		roots.length ? JSON.stringify(roots) : undefined,
		() => api("/api/project-pin", { root, pinned }),
		true,
	);
}

/** Reload them whenever the page is shown or focused again. */
export function reloadPrefsOnReturn(): void {
	addEventListener("focus", () => void loadPrefs());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void loadPrefs();
	});
}
