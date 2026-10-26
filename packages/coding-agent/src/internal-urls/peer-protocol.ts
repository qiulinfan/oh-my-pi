/**
 * `peer://`: the omp sessions other processes on this machine offer for
 * cross-session messaging (see `peers/registry.ts`). Read-only; messages go
 * through `write agent://<agent>@<session>`.
 */
import { listPeers, shortSessionId } from "../peers/registry";
import peerPromptDoc from "../prompts/internal-urls/peer.md" with { type: "text" };
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

export class PeerProtocolHandler implements ProtocolHandler {
	readonly scheme = "peer";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: false, linkable: true };

	promptDoc(): string {
		return peerPromptDoc.trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const own = context?.session?.getSessionId?.() ?? undefined;
		const peers = await listPeers();
		const rows: string[] = [];
		for (const peer of peers) {
			for (const session of peer.snapshot.sessions) {
				const self = own !== undefined && session.sessionId === own ? " (this session)" : "";
				const state = session.accepts ? (session.busy ? "busy" : "idle") : "editor, no messages";
				rows.push(
					`| \`Main@${session.short}\`${self} | ${session.name ?? "—"} | ${session.cwd} | ${session.mode} | ${state} | ${session.model ?? "—"} |`,
				);
			}
		}
		const content =
			rows.length === 0
				? "No omp sessions are open on this machine."
				: [
						"| Address | Name | Folder | Mode | State | Model |",
						"| --- | --- | --- | --- | --- | --- |",
						...rows,
						"",
						"Message one with `write agent://<address>`; a subagent of that session is `<id>@<short-id>`.",
					].join("\n");
		return { url: url.href || `peer://${own ? shortSessionId(own) : ""}`, content, contentType: "text/markdown" };
	}
}
