import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import type { Settings } from "../config/settings";
import { IrcBus } from "./bus";
import { PeerHost, parsePeerAddress } from "../peers/host";
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { canSpawnAtDepth } from "../task/types";

import { cfgTaskMaxRecursionDepth } from "../task/settings";

function coordinationErrorResult(text: string, details: CoordinationDetails): AgentToolResult<CoordinationDetails> {
	return { content: [{ type: "text", text }], details, isError: true };
}

/** Messaging is available to subagents and to top-level sessions able to spawn peers. */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	const maxDepth = cfgTaskMaxRecursionDepth.get(settings);
	return canSpawnAtDepth(maxDepth, taskDepth);
}

export function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	const progressTag = msg.progress ? " (progress; reply follows)" : "";
	return `[${msg.id}] ${msg.from}${replyTag}${progressTag}: ${msg.body}`;
}

/** Session-buffered inbox drain used before parking a bus waiter. */
export function drainPendingInbox(registry: AgentRegistry, senderId: string, from?: string): IrcMessage | undefined {
	const session = registry.get(senderId)?.session;
	return typeof session?.drainPendingIrcInboxMessages === "function"
		? session.drainPendingIrcInboxMessages(senderId, { from, limit: 1 })[0]
		: undefined;
}

/** `wait` result carrying a consumed message. */
export function messageResult(senderId: string, waited: IrcMessage): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: formatIncoming(waited) }],
		details: { op: "wait", from: senderId, waited },
	};
}

/**
 * The session id peers address `senderId` by: the top-level session of its
 * agent tree (a subagent's replies route through its root's process entry).
 */
function rootSessionId(registry: AgentRegistry, senderId: string): string | undefined {
	let ref = registry.get(senderId);
	const seen = new Set<string>();
	while (ref?.parentId && !seen.has(ref.id)) {
		seen.add(ref.id);
		const parent = registry.get(ref.parentId);
		if (!parent) break;
		ref = parent;
	}
	return ref?.session?.sessionId;
}

/** Send a direct message or broadcast; delivery never waits for a reply. */
export async function executeSend(
	deps: { registry: AgentRegistry; senderId: string; sessionFileHint?: string | null },
	params: { to: string; message: string; progress?: boolean },
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, sessionFileHint } = deps;
	const to = params.to.trim();
	const message = params.message;
	if (!to) return coordinationErrorResult("A recipient is required.", { op: "send", from: senderId });
	if (!message.trim())
		return coordinationErrorResult("A non-empty message is required.", { op: "send", from: senderId });
	if (to === senderId)
		return coordinationErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	if (parsePeerAddress(to)) {
		const sessionId = rootSessionId(registry, senderId);
		if (!sessionId)
			return coordinationErrorResult("This session cannot message other sessions.", {
				op: "send",
				from: senderId,
				to,
			});
		const sent = await PeerHost.global().send(senderId, sessionId, to, message);
		return {
			content: [{ type: "text", text: sent.text }],
			details: { op: "send", from: senderId, to: sent.canonical ?? to },
			isError: sent.isError,
		};
	}
	const isBroadcast = to === "all";
	// Restore parked recipients only when needed; never delay delivery to a live peer.
	if (!isBroadcast && sessionFileHint) {
		const recipient = registry.get(to);
		if (!recipient || recipient.status === "parked") await ensurePersistedRoster(registry, sessionFileHint);
	}

	const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
	const suppressRelay = isBroadcast && targets.includes(MAIN_AGENT_ID);
	// A turn acting on another session's request passes it on with what it sends.
	const peerRequest = registry.get(senderId)?.session?.peerTurn === true;
	const bus = IrcBus.global();
	const receipts = await Promise.all(
		targets.map(target =>
			bus.send(
				{
					from: senderId,
					to: target,
					body: message,
					...(isBroadcast ? { broadcast: true } : {}),
					...(peerRequest ? { peerRequest } : {}),
					...(params.progress ? { progress: true } : {}),
				},
				{ suppressRelay },
			),
		),
	);
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	let text: string;
	if (isBroadcast) {
		text =
			targets.length === 0
				? "No live peers to broadcast to."
				: `Broadcast delivered to ${delivered.length} of ${targets.length} peer(s).`;
		if (receipts.length) {
			text += `\n${receipts
				.map(receipt =>
					receipt.outcome === "failed"
						? `- ${receipt.to}: failed — ${receipt.error ?? "not running"}`
						: `- ${receipt.to}: ${receipt.outcome}`,
				)
				.join("\n")}`;
		}
	} else {
		const receipt = receipts[0]!;
		const recipient = registry.get(to);
		const unavailable = !recipient || recipient.status === "aborted" || !recipient.session;
		text =
			receipt.outcome === "failed"
				? `Failed: ${to} ${unavailable ? "is not running" : "could not receive the message"}. ${receipt.error ?? ""}`.trimEnd()
				: receipt.outcome === "revived"
					? `Queued for ${to} (was parked; revived).`
					: `Delivered to ${to}.`;
	}
	return {
		content: [{ type: "text", text }],
		details: { op: "send", from: senderId, to, receipts },
		isError: delivered.length === 0 && targets.length > 0,
	};
}
