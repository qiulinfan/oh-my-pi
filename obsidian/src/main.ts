/**
 * omp in an Obsidian sidebar: the page this machine's GUI server serves, in an
 * Electron <webview>. An <iframe> would not do: the server refuses requests a
 * browser marks cross-site, and a frame inside app://obsidian.md is one, while
 * a <webview> navigates at its own top level.
 *
 * Reaching the server is desktop/src/attach.ts, shared with the VS Code
 * extension: like the desktop app, the plugin attaches to the running server
 * or starts one, and a server it started stops with Obsidian, ending the
 * sessions it hosts.
 *
 * The page opens web links with window.open. A <webview> drops those unless it
 * allows popups, so it allows them and denies every one from the main
 * process, handing http(s) and mail links to the system instead.
 */
import * as os from "node:os";
import * as path from "node:path";
import { GuiAttachment } from "../../desktop/src/attach";
import { remote, shell } from "electron";
import { FileSystemAdapter, ItemView, Plugin, PluginSettingTab, Setting, type WorkspaceLeaf } from "obsidian";

const VIEW_TYPE = "omp-sidebar";
const EXTERNAL_LINK = /^(https?|mailto):/i;

/** The <webview> element's methods this plugin calls; the DOM typings do not know the tag. */
interface Webview extends HTMLElement {
	getWebContentsId(): number;
}

interface Settings {
	/** An absolute path to the omp to run; empty searches the login shell's PATH, then ~/.local/bin/omp. */
	ompPath: string;
	/** Set once the view has been put in the right sidebar, so a view the user closed stays closed. */
	sidebarPlaced: boolean;
}

const DEFAULT_SETTINGS: Settings = { ompPath: "", sidebarPlaced: false };

export default class OmpPlugin extends Plugin {
	override settings: Settings = { ...DEFAULT_SETTINGS };
	readonly server = new GuiAttachment();

	override async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
		this.registerView(VIEW_TYPE, leaf => new OmpView(leaf, this));
		this.addRibbonIcon("bot", "Open omp", () => void this.reveal());
		this.addCommand({ id: "open", name: "Open sidebar", callback: () => void this.reveal() });
		this.addSettingTab(new OmpSettingTab(this));
		this.app.workspace.onLayoutReady(() => void this.#placeOnce());
	}

	override onunload(): void {
		// Quitting Obsidian closes the server's stdin, which stops it anyway; this covers disabling the plugin.
		void this.server.stop();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Put the view in the right sidebar the first time the plugin loads in a
	 * vault, behind whatever tab is showing there, as Obsidian's own sidebar
	 * plugins do.
	 */
	async #placeOnce(): Promise<void> {
		if (this.settings.sidebarPlaced) return;
		const { workspace } = this.app;
		if (workspace.getLeavesOfType(VIEW_TYPE).length === 0) {
			await workspace.getRightLeaf(false)?.setViewState({ type: VIEW_TYPE, active: false });
		}
		this.settings.sidebarPlaced = true;
		await this.saveSettings();
	}

	async reveal(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}
}

class OmpView extends ItemView {
	readonly #plugin: OmpPlugin;
	/** Bumped by each load, so a slow load that a newer one replaced does not draw. */
	#generation = 0;

	constructor(leaf: WorkspaceLeaf, plugin: OmpPlugin) {
		super(leaf);
		this.#plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "omp";
	}

	override getIcon(): string {
		return "bot";
	}

	override async onOpen(): Promise<void> {
		this.addAction("refresh-cw", "Reconnect", () => void this.#load());
		const fit = () => this.#clearStatusBar();
		this.registerEvent(this.app.workspace.on("resize", fit));
		this.registerEvent(this.app.workspace.on("layout-change", fit));
		await this.#load();
		fit();
	}

	/**
	 * Obsidian's status bar floats over the bottom right of the window, where it would cover the page's
	 * composer in the right sidebar: leave the strip it covers, which themes and settings move or hide.
	 */
	#clearStatusBar(): void {
		const root = this.contentEl;
		root.style.paddingBottom = "";
		const bar = document.querySelector(".status-bar");
		if (!(bar instanceof HTMLElement) || !root.isShown()) return;
		const covers = bar.getBoundingClientRect();
		const view = root.getBoundingClientRect();
		const overlaps = covers.height > 0 && covers.left < view.right && covers.right > view.left;
		if (overlaps && covers.top < view.bottom) root.style.paddingBottom = `${Math.ceil(view.bottom - covers.top)}px`;
	}

	async #load(): Promise<void> {
		const generation = ++this.#generation;
		const root = this.contentEl;
		root.empty();
		root.addClass("omp-sidebar");
		const status = root.createDiv({ cls: "omp-sidebar-status", text: "Starting omp gui…" });
		let url: string;
		try {
			// New sessions start in the vault's folder.
			const { adapter } = this.app.vault;
			const vault = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
			url = await this.#plugin.server.pageUrl(this.#plugin.settings.ompPath || undefined, vault);
		} catch (err) {
			if (generation !== this.#generation) return;
			status.setText(err instanceof Error ? err.message : String(err));
			const retry = status.createEl("button", { text: "Retry" });
			retry.addEventListener("click", () => void this.#load());
			return;
		}
		if (generation !== this.#generation) return;
		status.remove();
		const page = document.createElement("webview") as Webview;
		// Its own persistent partition keeps the page's remembered picks across restarts, apart from Obsidian's storage.
		page.setAttribute("partition", "persist:omp-gui");
		page.setAttribute("allowpopups", "");
		page.addEventListener("dom-ready", () => {
			remote.webContents.fromId(page.getWebContentsId())?.setWindowOpenHandler(({ url }) => {
				if (EXTERNAL_LINK.test(url)) void shell.openExternal(url);
				return { action: "deny" };
			});
		});
		page.setAttribute("src", url);
		root.appendChild(page);
	}
}

class OmpSettingTab extends PluginSettingTab {
	readonly #plugin: OmpPlugin;

	constructor(plugin: OmpPlugin) {
		super(plugin.app, plugin);
		this.#plugin = plugin;
	}

	override display(): void {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName("omp executable")
			.setDesc(
				"An absolute path to the omp to run. Empty uses the first omp on the login shell's PATH, then ~/.local/bin/omp. Used the next time the plugin has to start or find the GUI server.",
			)
			.addText(text =>
				text
					.setPlaceholder(path.join(os.homedir(), ".local", "bin", "omp"))
					.setValue(this.#plugin.settings.ompPath)
					.onChange(async value => {
						this.#plugin.settings.ompPath = value.trim();
						await this.#plugin.saveSettings();
					}),
			);
	}
}
