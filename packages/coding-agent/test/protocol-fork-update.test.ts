import { afterEach, expect, it, spyOn } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { Settings } from "../src/config/settings";
import { clearOmpExtensionCliRoots } from "../src/discovery/omp-extension-roots";
import { runRootCommand } from "../src/main";
import { AuthStorage } from "../src/session/auth-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	clearOmpExtensionCliRoots();
	logger.endTiming();
});

for (const failure of [false, true]) {
	it(`ACP starts without waiting for a ${failure ? "failed" : "newer"} fork release and keeps stdout clean`, async () => {
		using dir = TempDir.createSync("@omp-protocol-update-");
		const auth = await AuthStorage.create(":memory:");
		const activeSettings = Settings.isolated({ "marketplace.autoUpdate": "off", "update.auto": false });
		const args = parseArgs([
			"--mode",
			"acp",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-tools",
			"--no-lsp",
		]);
		args.sessionDir = dir.path();
		const stop = new Error("stop test server");
		let checkedSettings: Settings | undefined;
		let finished = false;
		let release!: () => void;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const output: unknown[] = [];
		const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			output.push(chunk);
			return true;
		}) as typeof process.stdout.write);
		try {
			await expect(
				runRootCommand(args, [], {
					settings: activeSettings,
					discoverAuthStorage: async () => auth,
					checkForNewVersion: async settings => {
						checkedSettings = settings;
						timeout = setTimeout(release, 2000);
						await gate;
						finished = true;
						if (failure) throw new Error("GitHub unavailable");
						return "999.0.0 (aaaaaaaaaa)";
					},
					runAcpMode: async () => {
						expect(checkedSettings).toBe(activeSettings);
						expect(finished).toBe(false);
						release();
						await Bun.sleep(0);
						expect(finished).toBe(true);
						throw stop;
					},
				}),
			).rejects.toBe(stop);
			expect(output).toEqual([]);
		} finally {
			release();
			if (timeout) clearTimeout(timeout);
			stdout.mockRestore();
			auth.close();
		}
	}, 15_000);
}
