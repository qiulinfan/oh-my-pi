/**
 * A page framed by an editor's webview (the VS Code extension) cannot open windows: the webview's
 * sandbox allows no popups, so `window.open` and `target="_blank"` links do nothing there. In a frame,
 * web and mail links go to the embedder with postMessage instead, and it opens them in the browser.
 * The message carries only the URL that was clicked, so any embedder may receive it.
 */
export const OPEN_EXTERNAL = "omp-gui.open-external";

const WEB_LINK = /^(?:https?|mailto):/i;

export function routeLinksToEmbedder(): void {
	if (window.parent === window) return;
	const send = (url: string) => window.parent.postMessage({ type: OPEN_EXTERNAL, url }, "*");
	window.open = ((url?: string | URL) => {
		const href = url === undefined ? "" : String(url);
		if (WEB_LINK.test(href)) send(href);
		return null;
	}) as typeof window.open;
	// Capturing, so a link anywhere on the page is routed before it could navigate the frame away.
	document.addEventListener(
		"click",
		event => {
			const href = (event.target as Element | null)?.closest?.("a[href]")?.getAttribute("href");
			if (!href || !WEB_LINK.test(href)) return;
			event.preventDefault();
			send(href);
		},
		true,
	);
}
