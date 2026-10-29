/**
 * The GUI server for an editor that shows the page in one of its own panels
 * (the Obsidian and VS Code plugins in this repository). Like the desktop app
 * it attaches to the running server or starts one, with the login shell's
 * environment; a server it started stops with stop(), and with the editor,
 * whose exit closes the server's stdin. No Electron import, so the plugins
 * bundle it.
 */
import * as os from "node:os";
import { type LoginShellEnv, readLoginShellEnv } from "./login-shell";
import { findOmp, type GuiAddress, GuiProcess, pingGui } from "./supervisor";

interface Connection {
	address: GuiAddress;
	/** Set when the login shell's environment could not be read and this editor's server started without it. */
	degraded: boolean;
}

export class GuiAttachment {
	#env: Promise<LoginShellEnv> | null = null;
	/** The `omp gui` that serves, when this editor started the server rather than attaching to one. */
	#owned: GuiProcess | null = null;
	#connection: Promise<Connection> | null = null;

	/**
	 * The page to load: the running server's when it still answers, else one
	 * `omp gui` attaches to a server or starts one. `omp` names the executable
	 * to run; without it, the login shell's PATH, then ~/.local/bin/omp.
	 */
	async pageUrl(omp?: string): Promise<string> {
		let connection = this.#connection && (await this.#connection.catch(() => null));
		if (connection) {
			const ping = await pingGui(connection.address, connection.address);
			if (ping.state !== "ok" && ping.state !== "slow") connection = null;
		}
		if (!connection) {
			this.#connection = this.#connect(omp);
			connection = await this.#connection;
		}
		return `${connection.address.url}${connection.degraded ? "&env=degraded" : ""}`;
	}

	/** Stop a server this editor started; one it attached to keeps running. */
	async stop(): Promise<void> {
		await this.#owned?.stop();
	}

	async #connect(named: string | undefined): Promise<Connection> {
		if (this.#owned?.alive) await this.#owned.stop();
		this.#owned = null;
		this.#env ??= readLoginShellEnv();
		const env = await this.#env;
		const omp = await findOmp(named, env.env.PATH, os.homedir()).catch(err => {
			const why = env.failure ? ` (The login shell's environment could not be read: ${env.failure}.)` : "";
			throw new Error(`${err instanceof Error ? err.message : String(err)}${why}`);
		});
		const proc = new GuiProcess(omp, env.env, { cwd: os.homedir() });
		const address = await proc.ready();
		if (!address.attached) this.#owned = proc;
		return { address, degraded: env.failure !== undefined && !address.attached };
	}
}
