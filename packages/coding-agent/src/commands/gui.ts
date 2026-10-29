/**
 * Open the omp GUI in a browser.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { guiHelp as commandHelp } from "../cli/command-help";
import { runGuiCommand } from "../cli/gui-cli";

export default class Gui extends Command {
	static description = commandHelp.description;
	static flags = {
		port: Flags.integer({ char: "p", description: "Preferred port (any free port when taken)", default: 4317 }),
		"no-open": Flags.boolean({ description: "Do not open a browser window" }),
		json: Flags.boolean({ description: "Print the server address as one JSON line (for the desktop app)" }),
		"exit-on-stdin-close": Flags.boolean({
			description: "Stop the server, and the sessions it hosts, when stdin closes; used by the desktop app",
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gui);
		await runGuiCommand({
			port: flags.port,
			open: !flags["no-open"],
			json: flags.json ?? false,
			exitOnStdinClose: flags["exit-on-stdin-close"] ?? false,
		});
	}
}
