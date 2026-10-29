import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomically, writeFileAtomicallySync } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";

function eio(): NodeJS.ErrnoException {
	return Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
}

/**
 * Atomic writes flush the directory after the rename has published the file. A flush that fails
 * then (a filesystem refusing it, an I/O error) must not report the write as failed: the file
 * holds the new content, and a caller that took it for lost would retry or roll back state that
 * already matches the disk.
 */
describe.skipIf(process.platform === "win32")("atomic writes whose directory flush fails", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-atomic-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("resolves with the file published", async () => {
		const realOpen = fs.promises.open;
		let failed = 0;
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
			const handle = await realOpen(...args);
			if (args[0] === dir) {
				vi.spyOn(handle, "sync").mockImplementation(async () => {
					failed++;
					throw eio();
				});
			}
			return handle;
		});
		const file = path.join(dir, "settings.json");

		await writeFileAtomically(file, "new");

		expect(failed).toBe(1);
		expect(fs.readFileSync(file, "utf8")).toBe("new");
	});

	it("returns with the file published (sync)", () => {
		const realOpenSync = fs.openSync;
		const realFsyncSync = fs.fsyncSync;
		const dirFds = new Set<number>();
		let failed = 0;
		vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
			const fd = realOpenSync(...args);
			if (args[0] === dir) dirFds.add(fd);
			return fd;
		});
		vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
			if (!dirFds.has(fd)) return realFsyncSync(fd);
			failed++;
			throw eio();
		});
		const file = path.join(dir, "config.yml");

		writeFileAtomicallySync(file, "new");

		expect(failed).toBe(1);
		expect(fs.readFileSync(file, "utf8")).toBe("new");
	});
});
