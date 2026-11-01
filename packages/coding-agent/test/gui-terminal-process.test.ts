import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnTerminalProcess } from "../src/gui/terminal-process";

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Terminal did not deliver the expected output");
		await Bun.sleep(20);
	}
}

test("GUI terminal carries protocol output and keyboard input through the host transport", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-terminal-"));
	const script = path.join(dir, "child.js");
	await fs.writeFile(
		script,
		`if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("\\x1b_tsp;ready\\x1b\\\\");
process.stdin.on("data", data => {
  if (data.toString().includes("q")) { process.stdout.write("KEY_RECEIVED"); process.exit(0); }
});`,
	);
	let output = "";
	let eof = false;
	const child = await spawnTerminalProcess([process.execPath, script], {
		cwd: dir,
		env: { ...process.env, OMP_GUI_SERVER_PID: String(process.pid) },
		cols: 80,
		rows: 24,
		data: bytes => {
			output += new TextDecoder().decode(bytes);
		},
		eof: () => {
			eof = true;
		},
	});
	try {
		try {
			await waitFor(() => output.includes("tsp;ready"));
		} catch {
			throw new Error(`Terminal output: ${JSON.stringify(output)}; exit: ${child.exitCode}`);
		}
		expect(child.pid).toBeGreaterThan(0);
		child.terminal!.resize(100, 30);
		child.terminal!.write("q");
		expect(await child.exited).toBe(0);
		expect(output).toContain("KEY_RECEIVED");
		await waitFor(() => eof);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 20_000);

test("GUI terminal reports a missing executable", async () => {
	await expect(
		spawnTerminalProcess([path.join(os.tmpdir(), "omp-no-such-program.exe")], {
			cwd: os.tmpdir(),
			env: { ...process.env, OMP_GUI_SERVER_PID: String(process.pid) },
			cols: 80,
			rows: 24,
			data: () => {},
			eof: () => {},
		}),
	).rejects.toThrow();
});
