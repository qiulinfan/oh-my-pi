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
 *
 * As the caret moves in a file, the page hears where it is
 * (desktop/src/editor-context.ts), and offers it to omp with the next message.
 */
import * as vscode from "vscode";
import { GuiAttachment } from "../../desktop/src/attach";
import { EDITOR_CONTEXT, type EditorContext, editorContext } from "../../desktop/src/editor-context";

const VIEW_ID = "omp.gui";
/** What the page posts for a link it cannot open itself; packages/gui/src/embed.ts. */
const OPEN_EXTERNAL = "omp-gui.open-external";
const EXTERNAL_LINK = /^(?:https?|mailto):/i;
/** How long the caret rests before the page hears of it. */
const CARET_SETTLE_MS = 250;

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
	let settle: ReturnType<typeof setTimeout> | undefined;
	const caretMoved = () => {
		clearTimeout(settle);
		settle = setTimeout(() => provider.report(vscode.window.activeTextEditor), CARET_SETTLE_MS);
	};
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(caretMoved),
		vscode.window.onDidChangeActiveTextEditor(caretMoved),
		{ dispose: () => clearTimeout(settle) },
	);
	provider.report(vscode.window.activeTextEditor);
}

export function deactivate(): Promise<void> {
	// Quitting VS Code closes the server's stdin, which stops it anyway; this covers disabling the extension.
	return server.stop();
}

class OmpViewProvider implements vscode.WebviewViewProvider {
	#view: vscode.WebviewView | undefined;
	/** Bumped by each load, so a slow load that a newer one replaced does not draw. */
	#generation = 0;
	/** Where the caret last was in a file, which a page loaded later hears first. */
	#context: EditorContext | null = null;

	/** The page hears where the caret is in `editor`, when it shows a file on disk. */
	report(editor: vscode.TextEditor | undefined): void {
		if (editor?.document.uri.scheme !== "file") return;
		const { document, selection } = editor;
		this.#context = editorContext(
			document.uri.fsPath,
			{ line: selection.active.line, ch: selection.active.character },
			document.getText(selection),
			document.lineCount,
			line => document.lineAt(line).text,
		);
		void this.#view?.webview.postMessage({ type: EDITOR_CONTEXT, context: this.#context });
	}

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
			if (generation === this.#generation) view.webview.html = framePage(url, this.#context);
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

/** JSON to put inside a <script>, which a `</script>` in a file's text cannot end. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/**
 * The page in a frame, and the relay between them: the page's web links go to
 * the extension, and where the caret is goes to the page, `context` first.
 */
function framePage(url: string, context: EditorContext | null): string {
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
const origin = ${JSON.stringify(origin)};
let caret = ${scriptJson(context ? { type: EDITOR_CONTEXT, context } : null)};
const tell = () => { if (caret) frame.contentWindow.postMessage(caret, origin); };
frame.addEventListener("load", tell);
window.addEventListener("message", event => {
	const data = event.data;
	if (event.source === frame.contentWindow) {
		if (event.origin !== origin) return;
		if (data && data.type === ${JSON.stringify(OPEN_EXTERNAL)} && typeof data.url === "string") {
			vscode.postMessage({ type: data.type, url: data.url });
		}
	} else if (data && data.type === ${JSON.stringify(EDITOR_CONTEXT)}) {
		caret = data;
		tell();
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
