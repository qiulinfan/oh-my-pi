import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type Context,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { NestedContextLoader } from "@oh-my-pi/pi-coding-agent/session/nested-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/**
 * repo/
 *   .git/  .gitignore (ignored/)
 *   AGENTS.md            ROOT RULES   (cwd: already in the system prompt)
 *   pkg/AGENTS.md        PKG RULES
 *   pkg/deep/CLAUDE.md   DEEP RULES
 *   pkg/deep/{a,b}.ts
 *   ignored/AGENTS.md    IGNORED RULES
 *   ignored/sub/AGENTS.md  IGNORED SUB RULES  (listed by its parent, hidden by the ignored ancestor)
 *   ignored/sub/x.ts
 */
async function writeTree(root: string): Promise<void> {
	await fs.mkdir(path.join(root, ".git"), { recursive: true });
	await Bun.write(path.join(root, ".gitignore"), "ignored/\n");
	await Bun.write(path.join(root, "AGENTS.md"), "ROOT RULES\n");
	await Bun.write(path.join(root, "pkg", "AGENTS.md"), "PKG RULES\n");
	await Bun.write(path.join(root, "pkg", "deep", "CLAUDE.md"), "DEEP RULES\n");
	await Bun.write(path.join(root, "pkg", "deep", "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(root, "pkg", "deep", "b.ts"), "export const b = 2;\n");
	await Bun.write(path.join(root, "ignored", "AGENTS.md"), "IGNORED RULES\n");
	await Bun.write(path.join(root, "ignored", "sub", "AGENTS.md"), "IGNORED SUB RULES\n");
	await Bun.write(path.join(root, "ignored", "sub", "x.ts"), "export const x = 3;\n");
}

function developerTexts(context: Context | undefined): string[] {
	return (context?.messages ?? []).flatMap(message => {
		if (message.role !== "developer") return [];
		const content = message.content;
		return typeof content === "string"
			? [content]
			: content.flatMap(block => (block.type === "text" ? [block.text] : []));
	});
}

/** A model that reads each path in turn, one tool call per turn, then stops. */
function registerReader(api: string, reads: readonly string[]): Context[] {
	const contexts: Context[] = [];
	registerCustomApi(api, (_model, context) => {
		contexts.push(context);
		const turn = contexts.length - 1;
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			if (turn < reads.length) {
				const message = createAssistantMessage("");
				const toolCall = { type: "toolCall", id: `read-${turn}`, name: "read", arguments: { path: reads[turn] } };
				message.content = [toolCall as never];
				message.stopReason = "toolUse";
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
			}
		});
		return stream;
	});
	return contexts;
}

describe("nested context files", () => {
	afterEach(() => {
		clearCustomApis();
	});

	async function runSession(api: string, reads: readonly string[], settings: Record<string, unknown> = {}) {
		const tempDir = TempDir.createSync("@pi-nested-context-");
		const root = tempDir.path();
		await writeTree(root);
		const contexts = registerReader(api, reads);
		const model = buildModel({
			id: `${api}-model`,
			name: "Nested Context Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65536,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: tempDir.join(".agent-dir"),
			sessionManager: SessionManager.inMemory(root),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false, "tools.xdev": false, ...settings }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		try {
			await session.sendUserMessage("look around");
			return { contexts, systemPrompt: session.systemPrompt.join("\n") };
		} finally {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	}

	it("attaches every context file between cwd and a read file once, skipping ignored directories", async () => {
		const { contexts } = await runSession("test-nested-context-on", [
			"pkg/deep/a.ts",
			"pkg/deep/b.ts",
			"ignored/sub/x.ts",
		]);
		expect(contexts).toHaveLength(4);

		// First read in pkg/deep: pkg's AGENTS.md and deep's CLAUDE.md, parent first. The cwd's own
		// file lives in the system prompt and is not re-sent.
		const afterFirst = developerTexts(contexts[1]);
		expect(afterFirst).toHaveLength(1);
		expect(afterFirst[0]).toContain("PKG RULES");
		expect(afterFirst[0]).toContain("DEEP RULES");
		expect(afterFirst[0]!.indexOf("PKG RULES")).toBeLessThan(afterFirst[0]!.indexOf("DEEP RULES"));
		expect(afterFirst[0]).not.toContain("ROOT RULES");

		// A second read in the same directory adds nothing; nothing at or below a gitignored directory contributes.
		expect(developerTexts(contexts[2])).toEqual(afterFirst);
		expect(developerTexts(contexts[3])).toEqual(afterFirst);
	});

	it("attaches nothing when contextFiles.nested is off", async () => {
		const { contexts } = await runSession("test-nested-context-off", ["pkg/deep/a.ts"], {
			"contextFiles.nested": false,
		});
		expect(contexts).toHaveLength(2);
		expect(developerTexts(contexts[1])).toEqual([]);
	});

	it("lists nested AGENTS.md in the prompt index without the workspace tree", async () => {
		const { systemPrompt } = await runSession("test-nested-context-index", []);
		const dirContext = systemPrompt.slice(
			systemPrompt.indexOf("<dir-context>"),
			systemPrompt.indexOf("</dir-context>"),
		);
		expect(dirContext).toContain("- pkg/AGENTS.md");
		expect(dirContext).not.toContain("ignored/AGENTS.md");
		expect(systemPrompt).not.toContain("<workspace-tree>");
	});

	it("sends a file again once the message that carried it has left the context", async () => {
		using tempDir = TempDir.createSync("@pi-nested-context-loader-");
		const root = tempDir.path();
		await writeTree(root);
		const loader = new NestedContextLoader();
		const target = path.join(await fs.realpath(root), "pkg", "deep", "a.ts");

		const first = await loader.contextFor([target], [root], [], {});
		expect(first).toContain("PKG RULES");
		const carried: AgentMessage = {
			role: "developer",
			content: [{ type: "text", text: first! }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		expect(await loader.contextFor([target], [root], [carried], {})).toBeUndefined();

		// Compaction replaced the transcript with a summary: the delivery is gone, so it is sent again.
		const again = await loader.contextFor([target], [root], [], {});
		expect(again).toContain("PKG RULES");
		expect(again).toContain("DEEP RULES");
	});
});
