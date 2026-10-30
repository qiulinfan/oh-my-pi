/**
 * omp in VS Code's secondary side bar: the page this machine's GUI server
 * serves, in an <iframe> inside a webview view. The page itself is served
 * outside the server's request fence, and once it loads, its own requests go
 * to its own origin, so the frame being cross-site does not matter.
 *
 * Reaching the server is desktop/src/attach.ts, shared with the Obsidian
 * plugin: like the desktop app, the extension attaches to the running server
 * or starts one, and a server it started stops with VS Code, ending the
 * sessions it hosts.
 *
 * A webview's sandbox allows no popups, so the framed page posts web links to
 * this view (packages/gui's embed.ts), which opens them in the browser.
 */
import * as vscode from "vscode";
import { GuiAttachment } from "../../desktop/src/attach";

const VIEW_ID = "omp.gui";
/** What the page posts for a link it cannot open itself; packages/gui/src/embed.ts. */
const OPEN_EXTERNAL = "omp-gui.open-external";
const EXTERNAL_LINK = /^(?:https?|mailto):/i;

const server = new GuiAttachment();

export function activate(context: vscode.ExtensionContext): void {
	const provider = new OmpViewProvider();
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
			// Sessions run in the server, but the page holds the open view; keep it while the bar is hidden.
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("omp.reconnect", () => provider.load()),
	);
}

export function deactivate(): Promise<void> {
	// Quitting VS Code closes the server's stdin, which stops it anyway; this covers disabling the extension.
	return server.stop();
}

class OmpViewProvider implements vscode.WebviewViewProvider {
	#view: vscode.WebviewView | undefined;
	/** Bumped by each load, so a slow load that a newer one replaced does not draw. */
	#generation = 0;

	resolveWebviewView(view: vscode.WebviewView): void {
		this.#view = view;
		view.webview.options = { enableScripts: true };
		view.webview.onDidReceiveMessage((message: unknown) => {
			const { type, url } = (message ?? {}) as { type?: unknown; url?: unknown };
			if (type === "retry") void this.load();
			else if (type === OPEN_EXTERNAL && typeof url === "string" && EXTERNAL_LINK.test(url)) {
				void vscode.env.openExternal(vscode.Uri.parse(url, true));
			}
		});
		void this.load();
	}

	async load(): Promise<void> {
		const view = this.#view;
		if (!view) return;
		const generation = ++this.#generation;
		view.webview.html = statusPage("Starting omp gui…", false);
		const omp = vscode.workspace.getConfiguration("omp").get<string>("executable") || undefined;
		try {
			// New sessions start in the open folder (the first of a multi-root workspace).
			const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === "file")?.uri.fsPath;
			const url = await server.pageUrl(omp, folder);
			if (generation === this.#generation) view.webview.html = framePage(url);
		} catch (err) {
			if (generation === this.#generation) {
				view.webview.html = statusPage(err instanceof Error ? err.message : String(err), true);
			}
		}
	}
}

function nonce(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/** The page in a frame, and the relay that hands its web links to the extension. */
function framePage(url: string): string {
	const origin = new URL(url).origin;
	const n = nonce();
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
</head>
<body>
<iframe src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const frame = document.querySelector("iframe");
window.addEventListener("message", event => {
	if (event.source !== frame.contentWindow || event.origin !== ${JSON.stringify(origin)}) return;
	const data = event.data;
	if (data && data.type === ${JSON.stringify(OPEN_EXTERNAL)} && typeof data.url === "string") {
		vscode.postMessage({ type: data.type, url: data.url });
	}
});
</script>
</body>
</html>`;
}

/** A message while connecting, or why connecting failed, with Retry. */
function statusPage(text: string, retry: boolean): string {
	const n = nonce();
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>body { padding: 12px 16px; color: var(--vscode-descriptionForeground); font: var(--vscode-font-size) var(--vscode-font-family); user-select: text; } button { margin-top: 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 4px 12px; cursor: pointer; }</style>
</head>
<body>
<div>${escapeHtml(text)}</div>
${retry ? `<button>Retry</button><script nonce="${n}">const vscode = acquireVsCodeApi(); document.querySelector("button").addEventListener("click", () => vscode.postMessage({ type: "retry" }));</script>` : ""}
</body>
</html>`;
}
