/**
 * The part of the electron module Obsidian hands its plugins that this plugin
 * uses. Obsidian's renderer still exposes `remote` (Electron's own typings
 * dropped it), and the plugin does not install Electron for its typings.
 */
declare module "electron" {
	interface GuestContents {
		setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
	}
	export const remote: {
		webContents: { fromId(id: number): GuestContents | undefined };
	};
	export const shell: {
		openExternal(url: string): Promise<void>;
	};
}
