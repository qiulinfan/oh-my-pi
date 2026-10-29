import { TSP_KINDS, type TspKind } from "@oh-my-pi/pi-wire";

/**
 * Node kinds the browser view draws. omp falls back to pre-rendered ANSI
 * `rows` for any kind a terminal leaves out, so this list may only grow as
 * kinds get real renderers. `media` loads files by path, which a browser
 * view cannot do without a file route.
 */
export const SUPPORTED_KINDS: readonly TspKind[] = TSP_KINDS.filter(kind => kind !== "media");
