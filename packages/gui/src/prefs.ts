/**
 * The page's own preferences (theme, prose font, the start page's last picks), kept by the
 * GUI server rather than this browser's storage: the desktop app and the Obsidian and VS
 * Code side bars each have storage of their own, and should all show the same. They load
 * before the first render, so a chosen theme never flashes the default, and again whenever
 * the page comes back into view, since another window may have changed them meanwhile.
 */
import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { GuiPrefKey, GuiPrefs } from "./kinds";

let prefs: GuiPrefs = {};
const listeners = new Set<() => void>();

function replace(next: GuiPrefs): void {
	prefs = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Read them from the server; a page that cannot reach it keeps what it has, the defaults at first. */
export async function loadPrefs(): Promise<void> {
	try {
		replace(await api<GuiPrefs>("/api/prefs"));
	} catch {}
}

export function setPref(key: GuiPrefKey, value: string): void {
	replace({ ...prefs, [key]: value });
	api("/api/prefs", { key, value }).catch(() => {});
}

/** A preference and its setter; `fallback` stands in while it is unset. */
export function usePref(key: GuiPrefKey, fallback: string): [string, (value: string) => void] {
	const value = useSyncExternalStore(subscribe, () => prefs[key] || fallback);
	return [value, next => setPref(key, next)];
}

/** Reload them whenever the page is shown or focused again. */
export function reloadPrefsOnReturn(): void {
	addEventListener("focus", () => void loadPrefs());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void loadPrefs();
	});
}
