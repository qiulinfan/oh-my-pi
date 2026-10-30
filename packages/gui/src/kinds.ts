import { TSP_KINDS, type TspKind } from "@oh-my-pi/pi-wire";

/**
 * Node kinds the browser view draws. omp falls back to pre-rendered ANSI
 * `rows` for any kind a terminal leaves out, so this list may only grow as
 * kinds get real renderers. `media` loads files by path, which a browser
 * view cannot do without a file route.
 */
export const SUPPORTED_KINDS: readonly TspKind[] = TSP_KINDS.filter(kind => kind !== "media");

/**
 * The page's own preferences, which the GUI server keeps for every window onto it: the
 * desktop app and the Obsidian and VS Code side bars each have browser storage of their own.
 */
export const GUI_PREF_KEYS = [
	"theme",
	"prose",
	"project",
	"model",
	"thinking",
	"workDetail",
	"approvalMode",
	"pinnedProjects",
] as const;

export type GuiPrefKey = (typeof GUI_PREF_KEYS)[number];

export type GuiPrefs = Partial<Record<GuiPrefKey, string>>;

/** The project roots `pinnedProjects` holds (a JSON list), in the order they were pinned; malformed reads as none. */
export function pinnedProjectRoots(value: string | undefined): string[] {
	try {
		const roots: unknown = JSON.parse(value ?? "[]");
		return Array.isArray(roots) ? roots.filter((root): root is string => typeof root === "string") : [];
	} catch {
		return [];
	}
}
