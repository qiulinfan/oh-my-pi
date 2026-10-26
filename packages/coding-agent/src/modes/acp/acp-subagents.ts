/**
 * Subagents as ACP child sessions (the draft "subagents" RFD, which the Claude
 * ACP adapter also speaks). When the client declares
 * `clientCapabilities.subagents`, every subagent a session spawns (and theirs,
 * nested) is announced on its parent with `subagent_update`, and its own
 * events stream on the same connection under the child's session id, mapped
 * exactly like the parent's. Clients without the capability keep today's
 * flattened `task`/`wait` tool cards.
 *
 * The child's id is its AgentSession's id; its parent is the session (root or
 * child) whose agent spawned it, taken from the agent registry's `parentId`.
 */
import type { AgentSessionEvent } from "../../session/agent-session";
import { type AgentRef, AgentRegistry, type RegistryEvent } from "../../registry/agent-registry";
import { mapAgentSessionEventToAcpSessionUpdates } from "./acp-event-mapper";

/** Where a forwarder sends its notifications (the ACP connection's `sessionUpdate`). */
export type AcpSessionUpdateSink = (notification: {
	sessionId: string;
	update: Record<string, unknown>;
}) => Promise<void>;

interface Child {
	sessionId: string;
	parentSessionId: string;
	state: "running" | "idle";
	unsubscribe: () => void;
}

/** Whether the client asked for native subagent sessions (an object, like `{}`). */
export function clientSupportsSubagents(capabilities: { subagents?: unknown } | undefined): boolean {
	const subagents = capabilities?.subagents;
	return typeof subagents === "object" && subagents !== null && !Array.isArray(subagents);
}

export class AcpSubagentForwarder {
	readonly #rootAgentId: string;
	readonly #rootSessionId: string;
	readonly #send: AcpSessionUpdateSink;
	readonly #registry: AgentRegistry;
	readonly #children = new Map<string, Child>();
	/** Serializes notifications so a child's announcement always precedes its traffic. */
	#queue: Promise<void> = Promise.resolve();

	constructor(options: {
		rootAgentId: string;
		rootSessionId: string;
		send: AcpSessionUpdateSink;
		registry?: AgentRegistry;
	}) {
		this.#rootAgentId = options.rootAgentId;
		this.#rootSessionId = options.rootSessionId;
		this.#send = options.send;
		this.#registry = options.registry ?? AgentRegistry.global();
	}

	/** Start forwarding; the returned function stops it and drops every child subscription. */
	start(): () => void {
		const unsubscribe = this.#registry.onChange(event => this.#onRegistry(event));
		for (const ref of this.#registry.list()) this.#consider(ref);
		return () => {
			unsubscribe();
			for (const child of this.#children.values()) child.unsubscribe();
			this.#children.clear();
		};
	}

	#emit(sessionId: string, update: Record<string, unknown>): void {
		this.#queue = this.#queue.then(() => this.#send({ sessionId, update })).catch(() => {});
	}

	/** The ACP session a subagent is announced on: the root, or the child session of its parent agent. */
	#parentSessionOf(ref: AgentRef): string | undefined {
		if (!ref.parentId) return undefined;
		if (ref.parentId === this.#rootAgentId) return this.#rootSessionId;
		return this.#children.get(ref.parentId)?.sessionId;
	}

	#onRegistry(event: RegistryEvent): void {
		const child = this.#children.get(event.ref.id);
		if (event.type === "removed") {
			if (!child) return;
			this.#setState(child, "idle");
			child.unsubscribe();
			this.#children.delete(event.ref.id);
			return;
		}
		if (child) {
			this.#setState(child, event.ref.status === "running" ? "running" : "idle");
			return;
		}
		this.#consider(event.ref);
	}

	#consider(ref: AgentRef): void {
		if (ref.kind !== "sub" || !ref.session || this.#children.has(ref.id)) return;
		const parentSessionId = this.#parentSessionOf(ref);
		if (!parentSessionId) return;
		const session = ref.session;
		const sessionId = session.sessionId;
		const state = ref.status === "running" ? "running" : "idle";
		this.#emit(parentSessionId, {
			sessionUpdate: "subagent_update",
			sessionId,
			title: ref.id,
			description: ref.activity ? `${ref.displayName}: ${ref.activity}` : ref.displayName,
			state: { state },
		});
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			for (const notification of mapAgentSessionEventToAcpSessionUpdates(event, sessionId, {
				cwd: session.sessionManager.getCwd(),
			})) {
				this.#emit(notification.sessionId, notification.update as unknown as Record<string, unknown>);
			}
		});
		this.#children.set(ref.id, { sessionId, parentSessionId, state, unsubscribe });
	}

	#setState(child: Child, state: "running" | "idle"): void {
		if (child.state === state) return;
		child.state = state;
		this.#emit(child.parentSessionId, {
			sessionUpdate: "subagent_update",
			sessionId: child.sessionId,
			state: { state },
		});
	}
}
