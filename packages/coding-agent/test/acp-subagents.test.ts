import { describe, expect, it } from "bun:test";
import { AcpSubagentForwarder, clientSupportsSubagents } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-subagents";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function fakeSession(sessionId: string) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId,
		sessionManager: { getCwd: () => "/work" },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as AgentSession;
	return { session, emit: (event: AgentSessionEvent) => listeners.forEach(listener => listener(event)), listeners };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

describe("ACP subagent child sessions", () => {
	it("announces a subagent on its parent, then streams its events under the child's own session id", async () => {
		const registry = new AgentRegistry();
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const stop = new AcpSubagentForwarder({
			rootAgentId: "acp:root",
			rootSessionId: "root",
			registry,
			send: async notification => {
				sent.push(notification);
			},
		}).start();

		const child = fakeSession("child-1");
		registry.register({
			id: "Scout",
			displayName: "explore",
			kind: "sub",
			parentId: "acp:root",
			session: null,
			status: "running",
		});
		// Nothing to follow until the subagent has a session.
		await settle();
		expect(sent).toEqual([]);
		registry.attachSession("Scout", child.session);
		child.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "a.ts" },
		} as unknown as AgentSessionEvent);
		registry.setStatus("Scout", "idle");
		await settle();

		expect(sent[0]).toEqual({
			sessionId: "root",
			update: {
				sessionUpdate: "subagent_update",
				sessionId: "child-1",
				title: "Scout",
				description: "explore",
				state: { state: "running" },
			},
		});
		const childTraffic = sent.filter(entry => entry.sessionId === "child-1");
		expect(childTraffic.map(entry => entry.update.sessionUpdate)).toContain("tool_call");
		expect(sent.at(-1)).toEqual({
			sessionId: "root",
			update: { sessionUpdate: "subagent_update", sessionId: "child-1", state: { state: "idle" } },
		});

		stop();
		expect(child.listeners.size).toBe(0);
	});

	it("announces a nested subagent on its parent's child session and ignores other sessions' subagents", async () => {
		const registry = new AgentRegistry();
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const stop = new AcpSubagentForwarder({
			rootAgentId: "acp:root",
			rootSessionId: "root",
			registry,
			send: async notification => {
				sent.push(notification);
			},
		}).start();
		registry.register({
			id: "Lead",
			displayName: "task",
			kind: "sub",
			parentId: "acp:root",
			session: fakeSession("lead").session,
			status: "running",
		});
		registry.register({
			id: "Lead.Helper",
			displayName: "task",
			kind: "sub",
			parentId: "Lead",
			session: fakeSession("helper").session,
			status: "running",
		});
		registry.register({
			id: "Elsewhere",
			displayName: "task",
			kind: "sub",
			parentId: "acp:other",
			session: fakeSession("other").session,
			status: "running",
		});
		await settle();
		const announced = sent
			.filter(entry => entry.update.sessionUpdate === "subagent_update")
			.map(entry => [entry.sessionId, entry.update.sessionId]);
		expect(announced).toEqual([
			["root", "lead"],
			["lead", "helper"],
		]);
		stop();
	});

	it("only clients that send an object for `subagents` get child sessions", () => {
		expect(clientSupportsSubagents({ subagents: {} })).toBe(true);
		expect(clientSupportsSubagents({ subagents: true })).toBe(false);
		expect(clientSupportsSubagents({})).toBe(false);
		expect(clientSupportsSubagents(undefined)).toBe(false);
	});
});
