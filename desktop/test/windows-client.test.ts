import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLoginShellEnv } from "../src/login-shell";
import { findOmp } from "../src/supervisor";

test.skipIf(process.platform !== "win32")(
	"Windows editor inherits native paths without probing a POSIX shell",
	async () => {
		const result = await readLoginShellEnv({ base: { Path: "C:\\native tools", ComSpec: "cmd.exe", PWD: "old" } });
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-windows-client-"));
		try {
			const executable = path.join(dir, "omp.exe");
			await fs.copyFile(process.execPath, executable);
			expect(await findOmp(undefined, dir, os.tmpdir())).toBe(executable);
			expect(result.failure).toBeUndefined();
			expect(result.env.Path).toBe("C:\\native tools");
			expect(result.env.PWD).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	},
);
