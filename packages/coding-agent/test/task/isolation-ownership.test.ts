import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import {
	hasLiveIsolationOwner,
	ISOLATION_OWNER_FILE,
	needsNativeTeardown,
	writeIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { processStartToken } from "@oh-my-pi/pi-coding-agent/utils/process-identity";
import { $ } from "bun";

const { IsoBackendKind } = natives;

// The sidecar set decides which retained workspaces `omp worktree clear`
// routes through native `isoStop` instead of plain recursive `rm`.
describe("retained workspace teardown set", () => {
	it("routes mounts and subvolumes through native teardown, nothing else", () => {
		for (const kind of [IsoBackendKind.Overlayfs, IsoBackendKind.Projfs, IsoBackendKind.Btrfs]) {
			expect(needsNativeTeardown(kind)).toBe(true);
		}
		for (const kind of [
			IsoBackendKind.Apfs,
			// ZFS clones need dataset-aware teardown too, but isoStop locates
			// the dataset by its recorded mountpoint property, which no longer
			// matches after the retain rename — pi-iso mount-table support first.
			IsoBackendKind.Zfs,
			IsoBackendKind.LinuxReflink,
			IsoBackendKind.WindowsBlockClone,
			IsoBackendKind.Rcopy,
		]) {
			expect(needsNativeTeardown(kind)).toBe(false);
		}
	});

	it("rejects non-backend values", () => {
		for (const value of [undefined, null, "overlayfs", 1.5, -1, 999]) {
			expect(needsNativeTeardown(value)).toBe(false);
		}
	});
});

/**
 * `omp worktree clear` may run in a shell whose locale and time zone differ from
 * the omp that owns a sandbox. The owner check must still recognise the live
 * owner, or clear deletes a running subagent's sandbox.
 */
describe("sandbox owner liveness across locales and time zones", () => {
	const OTHER_ZONE = { TZ: "Pacific/Kiritimati", LC_ALL: "zh_CN.UTF-8" };
	const MODULE = path.join(import.meta.dir, "../../src/task/isolation-ownership.ts");
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-owner-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** `hasLiveIsolationOwner(dir)` as a process running under `env` (a `worktree clear` in another shell) answers it. */
	async function liveOwnerSeenFrom(env: Record<string, string>): Promise<boolean> {
		const script = `import { hasLiveIsolationOwner } from ${JSON.stringify(MODULE)};
process.stdout.write(JSON.stringify(await hasLiveIsolationOwner(process.env.OWNER_DIR)));`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			env: { ...process.env, ...env, OWNER_DIR: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`owner check exited ${code}: ${err}`);
		return JSON.parse(out) as boolean;
	}

	it("keeps a live owner's sandbox when the check runs in another locale and time zone", async () => {
		await writeIsolationOwner(dir, "zone0001"); // marker names this test process

		expect(await liveOwnerSeenFrom(OTHER_ZONE)).toBe(true);
	});

	// Linux tokens always came from /proc, and Windows records none: only other
	// Unixes have markers in the older `ps` format.
	it.skipIf(process.platform === "linux" || process.platform === "win32")(
		"keeps a sandbox whose marker an older omp wrote in its own locale and time zone",
		async () => {
			// What an older omp running in OTHER_ZONE recorded for itself: `ps` in its own environment.
			const legacy = (
				await $`ps -o lstart= -p ${process.pid}`
					.env({ ...process.env, ...OTHER_ZONE })
					.quiet()
					.text()
			).trim();
			expect(legacy).not.toBe(await processStartToken(process.pid));
			await Bun.write(
				path.join(dir, ISOLATION_OWNER_FILE),
				JSON.stringify({ pid: process.pid, id: "legacy01", startToken: legacy }),
			);

			expect(await liveOwnerSeenFrom(OTHER_ZONE)).toBe(true);
		},
	);

	// The older format has the same shape as today's in the C locale, only in local time. A
	// process that took a dead owner's pid as many hours after the owner started as the checker
	// is behind UTC reads, in that format, as the owner's recorded token: only an older omp's
	// marker may be matched that way, or the dead sandbox stays pinned while that process runs.
	it.skipIf(process.platform === "linux" || process.platform === "win32")(
		"reclaims a sandbox whose current-format token only matches the pid's start in local time",
		async () => {
			const cZone = { TZ: "Pacific/Pago_Pago", LC_ALL: "C" };
			// This process's start in cZone's local time (UTC-11): the UTC start of an owner that
			// started 11 hours before it, wore its pid and died.
			const deadOwnerToken = (
				await $`ps -o lstart= -p ${process.pid}`
					.env({ ...process.env, ...cZone })
					.quiet()
					.text()
			).trim();
			expect(deadOwnerToken).not.toBe(await processStartToken(process.pid));
			await Bun.write(
				path.join(dir, ISOLATION_OWNER_FILE),
				JSON.stringify({ pid: process.pid, id: "reused01", startToken: deadOwnerToken, startTokenFormat: 2 }),
			);

			expect(await liveOwnerSeenFrom(cZone)).toBe(false);
		},
	);

	// A newer omp may record its token another way; this build cannot check that token, and an
	// older `omp worktree clear` must not delete the newer omp's running sandbox over it.
	it("keeps a live owner whose token is in a format this build does not know", async () => {
		await Bun.write(
			path.join(dir, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: process.pid, id: "future01", startToken: "a later format", startTokenFormat: 3 }),
		);

		expect(await hasLiveIsolationOwner(dir)).toBe(true);
	});
});
