/**
 * Per-process side of cross-session messaging. Top-level sessions register
 * here; the first registration publishes this process in the peer registry,
 * and the last one to go withdraws it.
 *
 * Addresses: `<agent>@<session>` where `<agent>` is `Main` or a subagent id
 * inside that session's process, and `<session>` is a session's short id
 * (`shortSessionId`), a longer id prefix, or its name. A message that arrives
 * from another process enters the local IRC bus with `from` set to the
 * sender's qualified address, so it can never pass for the recipient's parent
 * (parent checks compare bare ids) and the reply goes back the same way.
 */
import { IrcBus } from "../irc/bus";
import type { AgentSession } from "../session/agent-session";
import {
	deliverToPeer,
	type LivePeer,
	listPeers,
	type PeerDeliverReceipt,
	type PeerDeliverRequest,
	type PeerMode,
	type PeerPublication,
	type PeerSessionInfo,
	type PeerSnapshot,
	publishPeer,
	shortSessionId,
} from "./registry";

interface Hosted {
	session: AgentSession;
	agentId: string;
	mode: PeerMode;
}

export interface ResolvedPeerAddress {
	peer: LivePeer;
	session: PeerSessionInfo;
	agent: string;
	/** Canonical form `<agent>@<short>`: what replies come from. */
	canonical: string;
}

function slug(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/^[\p{Co}\s]+/u, "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");
}

/** How this process hosts `agentId`'s session; argv tells print and RPC runs apart from the TUI. */
export function peerModeFor(agentId: string, argv: readonly string[] = process.argv): PeerMode {
	if (agentId.startsWith("acp:")) return "acp";
	const modeAt = argv.indexOf("--mode");
	const mode = modeAt === -1 ? argv.find(arg => arg.startsWith("--mode="))?.slice(7) : argv[modeAt + 1];
	if (mode === "rpc" || mode === "rpc-ui") return "rpc";
	if (argv.includes("-p") || argv.includes("--print") || mode === "json" || mode === "text") return "print";
	return "tui";
}

/** Split `<agent>@<session>`; null when `to` names a local agent. */
export function parsePeerAddress(to: string): { agent: string; session: string } | null {
	const at = to.lastIndexOf("@");
	if (at <= 0 || at === to.length - 1) return null;
	return { agent: to.slice(0, at), session: to.slice(at + 1) };
}

export class PeerHost {
	static #global: PeerHost | undefined;

	/** This process's host: publishes nothing until {@link enableGlobal}, so SDK embedders and tests stay private. */
	static global(): PeerHost {
		PeerHost.#global ??= new PeerHost({ enabled: false });
		return PeerHost.#global;
	}

	/** The omp CLI offers its own sessions to peers; called once at startup. */
	static enableGlobal(): void {
		PeerHost.global().#enabled = true;
	}

	readonly #hosted = new Set<Hosted>();
	readonly #dir: string | undefined;
	readonly #bus: () => IrcBus;
	#publication: Promise<PeerPublication | null> | null = null;
	#enabled: boolean;

	constructor(options?: { dir?: string; bus?: IrcBus; enabled?: boolean }) {
		this.#dir = options?.dir;
		this.#bus = () => options?.bus ?? IrcBus.global();
		this.#enabled = options?.enabled ?? true;
	}

	/** Offer `session` to peers until the returned function runs (call it on dispose). */
	register(session: AgentSession, agentId: string, mode: PeerMode): () => void {
		if (!this.#enabled) return () => {};
		const entry: Hosted = { session, agentId, mode };
		this.#hosted.add(entry);
		this.#publication ??= publishPeer(this, { dir: this.#dir }).catch(() => null);
		return () => {
			this.#hosted.delete(entry);
			if (this.#hosted.size > 0 || !this.#publication) return;
			const publication = this.#publication;
			this.#publication = null;
			void publication.then(published => published?.close());
		};
	}

	/** Resolves once this process's entry is published (or publishing failed). */
	async ready(): Promise<void> {
		await this.#publication;
	}

	/** The short id of the session `agentId` belongs to in this process, if hosted here. */
	addressOf(agentId: string, fallbackSessionId?: string): string | undefined {
		for (const entry of this.#hosted)
			if (entry.agentId === agentId) return `Main@${shortSessionId(entry.session.sessionId)}`;
		return fallbackSessionId ? `${agentId}@${shortSessionId(fallbackSessionId)}` : undefined;
	}

	snapshot(): PeerSnapshot {
		const sessions: PeerSessionInfo[] = [];
		for (const { session, agentId, mode } of this.#hosted) {
			if (session.isDisposed) continue;
			const model = session.model;
			sessions.push({
				sessionId: session.sessionId,
				short: shortSessionId(session.sessionId),
				agentId,
				name: session.sessionName ?? null,
				cwd: session.sessionManager.getCwd(),
				mode,
				busy: session.isStreaming,
				model: model ? `${model.provider}/${model.id}` : null,
				// An ACP session's client sees only the turns it prompts; a message would run a billed turn it never shows.
				accepts: mode !== "acp",
			});
		}
		return { instanceId: String(process.pid), pid: process.pid, sessions };
	}

	async deliver(request: PeerDeliverRequest): Promise<PeerDeliverReceipt> {
		const entry = [...this.#hosted].find(
			hosted => !hosted.session.isDisposed && hosted.session.sessionId === request.to.sessionId,
		);
		if (!entry) return { outcome: "failed", error: "that session is no longer open in its process" };
		if (entry.mode === "acp") {
			return {
				outcome: "failed",
				error: "that session runs in an editor (ACP); it does not take messages from other sessions",
			};
		}
		const to = request.to.agent === "Main" ? entry.agentId : request.to.agent;
		const receipt = await this.#bus().send({ from: request.from, to, body: request.body, replyTo: request.replyTo });
		return { outcome: receipt.outcome, error: receipt.error };
	}

	/** Find the session `<agent>@<session>` names among live peers (this process included). */
	async resolve(to: string, options?: { timeoutMs?: number }): Promise<ResolvedPeerAddress | { error: string }> {
		const parsed = parsePeerAddress(to);
		if (!parsed) return { error: `"${to}" is not a cross-session address (<agent>@<session>).` };
		const peers = await listPeers({ dir: this.#dir, timeoutMs: options?.timeoutMs });
		const wanted = parsed.session.toLowerCase();
		const candidates: Array<{ peer: LivePeer; session: PeerSessionInfo }> = [];
		for (const peer of peers) {
			for (const session of peer.snapshot.sessions) {
				const id = session.sessionId.replaceAll("-", "").toLowerCase();
				const byId =
					session.short === wanted || (wanted.length >= 6 && (id.startsWith(wanted) || id.endsWith(wanted)));
				const byName = session.name !== null && slug(session.name) === slug(parsed.session);
				if (byId || byName) candidates.push({ peer, session });
			}
		}
		if (candidates.length === 0) {
			const known = peers.flatMap(peer =>
				peer.snapshot.sessions.map(s => `${s.short}${s.name ? ` (${s.name})` : ""}`),
			);
			return {
				error: `No live session matches "${parsed.session}".${known.length ? ` Live sessions: ${known.join(", ")}.` : " No other sessions are running."} Read peer:// for the list.`,
			};
		}
		if (candidates.length > 1) {
			return {
				error: `"${parsed.session}" matches ${candidates.length} sessions (${candidates.map(c => c.session.short).join(", ")}); use the short id.`,
			};
		}
		const { peer, session } = candidates[0]!;
		return { peer, session, agent: parsed.agent, canonical: `${parsed.agent}@${session.short}` };
	}

	/** Send `body` from local agent `senderId` (in session `senderSessionId`) to a session elsewhere. */
	async send(
		senderId: string,
		senderSessionId: string,
		to: string,
		body: string,
	): Promise<{ text: string; isError: boolean; canonical?: string; receipt?: PeerDeliverReceipt }> {
		const resolved = await this.resolve(to);
		if ("error" in resolved) return { text: resolved.error, isError: true };
		if (
			resolved.session.sessionId === senderSessionId &&
			(resolved.agent === "Main" ? resolved.session.agentId : resolved.agent) === senderId
		) {
			return { text: "Cannot send a message to yourself.", isError: true };
		}
		if (!resolved.session.accepts) {
			return {
				text: `${resolved.canonical} runs in an editor (ACP) and does not take messages from other sessions.`,
				isError: true,
			};
		}
		// The reply address: the sender's own agent id qualified by its session.
		const from = `${senderId === this.#mainAgentOf(senderSessionId) ? "Main" : senderId}@${shortSessionId(senderSessionId)}`;
		const receipt = await deliverToPeer(resolved.peer, {
			to: { sessionId: resolved.session.sessionId, agent: resolved.agent },
			from,
			body,
		});
		if (receipt.outcome === "failed")
			return {
				text: `Failed: ${resolved.canonical} — ${receipt.error ?? "not delivered"}`,
				isError: true,
				canonical: resolved.canonical,
				receipt,
			};
		this.#bus().recordRemoteSend(senderId, resolved.canonical);
		const where = resolved.session.name ? ` (${resolved.session.name})` : "";
		const how = receipt.outcome === "woken" ? "delivered; it was idle and started a turn" : "delivered";
		return {
			text: `Message to ${resolved.canonical}${where} ${how}. Replies arrive as messages from ${resolved.canonical}.`,
			isError: false,
			canonical: resolved.canonical,
			receipt,
		};
	}

	#mainAgentOf(sessionId: string): string | undefined {
		for (const entry of this.#hosted) if (entry.session.sessionId === sessionId) return entry.agentId;
		return undefined;
	}
}
