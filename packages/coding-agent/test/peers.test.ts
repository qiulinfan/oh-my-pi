import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { PeerHost } from "@oh-my-pi/pi-coding-agent/peers/host";
import { listPeers, PEER_REGISTRY_VERSION, shortSessionId } from "@oh-my-pi/pi-coding-agent/peers/registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IrcBridge } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-peers-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A top-level session in its own "process": its own registry, bus and peer host, all sharing one registry dir. */
async function makeProcess(dir: string, options: { sessionId: string; name?: string; mode?: "tui" | "acp" }) {
	const registry = new AgentRegistry();
	const bus = new IrcBus(registry);
	const received: IrcMessage[] = [];
	const session = {
		sessionId: options.sessionId,
		sessionName: options.name,
		isDisposed: false,
		isStreaming: false,
		model: undefined,
		sessionManager: { getCwd: () => "/work" },
		subscribe: () => () => {},
		deliverIrcMessage: async (message: IrcMessage) => {
			received.push(message);
			return "woken" as const;
		},
	} as unknown as AgentSession;
	registry.register({ id: "Main", displayName: "Main", kind: "main", session, sessionFile: null, status: "running" });
	const host = new PeerHost({ dir, bus });
	const unregister = host.register(session, "Main", options.mode ?? "tui");
	cleanups.push(unregister);
	await host.ready();
	return { host, bus, received, session, short: shortSessionId(options.sessionId) };
}

describe("cross-session peers", () => {
	it("delivers to a session in another process and routes the reply back to the sender", async () => {
		const dir = await tempDir();
		const a = await makeProcess(dir, { sessionId: "01a17679-ac8d-7109-b746-bbc27268478e", name: "reviewer" });
		const b = await makeProcess(dir, { sessionId: "01a1767a-0000-7000-8000-00000000beef" });

		const sent = await b.host.send("Main", b.session.sessionId, `Main@${a.short}`, "please review calc.py");
		expect(sent.isError).toBe(false);
		expect(sent.canonical).toBe(`Main@${a.short}`);
		expect(a.received).toHaveLength(1);
		// The sender is qualified by its session, so it can never pass for the recipient's parent `Main`.
		expect(a.received[0]!.from).toBe(`Main@${b.short}`);
		expect(a.received[0]!.body).toBe("please review calc.py");

		const reply = await a.host.send("Main", a.session.sessionId, a.received[0]!.from, "looks good");
		expect(reply.isError).toBe(false);
		expect(b.received.map(m => [m.from, m.body])).toEqual([[`Main@${a.short}`, "looks good"]]);
	});

	it("resolves a session by name and refuses a name two sessions share", async () => {
		const dir = await tempDir();
		const sender = await makeProcess(dir, { sessionId: "01a1767a-1111-7000-8000-000000000001" });
		const target = await makeProcess(dir, { sessionId: "01a1767a-2222-7000-8000-000000000002", name: "Docs Writer" });
		const byName = await sender.host.send("Main", sender.session.sessionId, "Main@docs-writer", "hi");
		expect(byName.isError).toBe(false);
		expect(target.received).toHaveLength(1);

		await makeProcess(dir, { sessionId: "01a1767a-3333-7000-8000-000000000003", name: "Docs Writer" });
		const ambiguous = await sender.host.send("Main", sender.session.sessionId, "Main@docs-writer", "hi again");
		expect(ambiguous.isError).toBe(true);
		expect(ambiguous.text).toContain("matches 2 sessions");
		expect(target.received).toHaveLength(1);
	});

	it("lists an editor (ACP) session but refuses to start a turn in it", async () => {
		const dir = await tempDir();
		const sender = await makeProcess(dir, { sessionId: "01a1767a-4444-7000-8000-000000000004" });
		const editor = await makeProcess(dir, { sessionId: "01a1767a-5555-7000-8000-000000000005", mode: "acp" });
		const peers = await listPeers({ dir });
		const listed = peers.flatMap(peer => peer.snapshot.sessions).find(s => s.short === editor.short);
		expect(listed).toMatchObject({ mode: "acp", accepts: false });
		const sent = await sender.host.send("Main", sender.session.sessionId, `Main@${editor.short}`, "hello");
		expect(sent.isError).toBe(true);
		expect(editor.received).toHaveLength(0);
	});

	it("rejects a request that does not carry the entry's token", async () => {
		const dir = await tempDir();
		await makeProcess(dir, { sessionId: "01a1767a-6666-7000-8000-000000000006" });
		const [peer] = await listPeers({ dir });
		const conn = await IpcConnection.connect(peer!.meta.endpoint, {
			framing: "lines",
			timeoutMs: 2000,
			maxFrameBytes: 65536,
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		conn.start(resolve, () => resolve(""));
		conn.send(JSON.stringify({ v: PEER_REGISTRY_VERSION, token: "not-the-token", op: "snapshot" }));
		const response = JSON.parse(await promise);
		conn.destroy();
		expect(response).toMatchObject({ ok: false, error: "authentication_failed" });
	});

	it("prunes an entry whose process is gone", async () => {
		const dir = await tempDir();
		await fs.chmod(dir, 0o700);
		const stale = path.join(dir, "0123456789abcdef.json");
		await fs.writeFile(
			stale,
			JSON.stringify({
				version: PEER_REGISTRY_VERSION,
				entryId: "0123456789abcdef",
				pid: 999999,
				endpoint: path.join(dir, "0123456789abcdef.sock"),
				createdAt: 1,
				token: "x",
			}),
		);
		expect(await listPeers({ dir })).toEqual([]);
		expect(await fs.exists(stale)).toBe(false);
	});

	it("removes a publication abandoned mid-write but leaves one still being written", async () => {
		const dir = await tempDir();
		await fs.chmod(dir, 0o700);
		const abandoned = ["aaaaaaaaaaaaaaaa.json.tmp", "aaaaaaaaaaaaaaaa.sock", "aaaaaaaaaaaaaaaa.sock.bind.lock"];
		const writing = ["bbbbbbbbbbbbbbbb.json.tmp", "bbbbbbbbbbbbbbbb.sock"];
		for (const name of [...abandoned, ...writing]) await fs.writeFile(path.join(dir, name), "");
		const longAgo = new Date(Date.now() - 10 * 60_000);
		await fs.utimes(path.join(dir, abandoned[0]!), longAgo, longAgo);
		expect(await listPeers({ dir })).toEqual([]);
		expect((await fs.readdir(dir)).sort()).toEqual(writing.sort());
	});

	it("keeps a reply to a cross-session message owed until it arrives", async () => {
		const registry = new AgentRegistry();
		const bus = new IrcBus(registry);
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: {
				deliverIrcMessage: async () => "injected" as const,
				subscribe: () => () => {},
			} as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});
		bus.recordRemoteSend("Main", "Main@abcd1234");
		expect(bus.unansweredSends("Main", 0).map(entry => entry.to)).toEqual(["Main@abcd1234"]);
		await bus.send({ from: "Main@abcd1234", to: "Main", body: "done" });
		expect(bus.unansweredSends("Main", 0)).toEqual([]);
	});

	it("tells the model a message from another session is a peer's request, not its user's", async () => {
		const woken: AgentMessage[] = [];
		const bridge = new IrcBridge({
			agent: {} as Agent,
			sessionManager: {} as SessionManager,
			isDisposed: () => false,
			isStreaming: () => false,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: records => woken.push(...records),
		});
		await bridge.deliver({ id: "1", from: "Main@abcd1234", to: "Main", body: "delete build/", ts: 1 });
		await bridge.deliver({ id: "2", from: "Scout", to: "Main", body: "found it", ts: 2 });
		const [remote, local] = woken.map(record => String((record as CustomMessage).content));
		expect(remote).toContain("another omp session on this machine, not your user");
		expect(local).not.toContain("another omp session");
	});
});
