import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setSessionOrigin, setSessionOriginClient } from "@oh-my-pi/pi-coding-agent/session/session-origin";

// sync-sessions and the IINA panel pick sessions by the origin in the saved header.
async function savedHeader(): Promise<Record<string, unknown>> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-origin-"));
	try {
		const manager = SessionManager.create(dir, dir);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		await manager.close();
		const lines = (await Bun.file(file!).text()).split("\n").filter(Boolean);
		return JSON.parse(lines.find(line => JSON.parse(line).type === "session")!);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("session origin", () => {
	afterEach(() => setSessionOrigin(undefined));

	it("names the ACP client that introduced itself in new sessions", async () => {
		setSessionOrigin({ mode: "acp" });
		setSessionOriginClient("zed");
		expect((await savedHeader()).origin).toEqual({ mode: "acp", client: "zed" });
	});

	it("leaves the origin out of sessions an SDK embedder creates", async () => {
		expect("origin" in (await savedHeader())).toBe(false);
	});
});
