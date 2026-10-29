import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { setWorkDetail, type WorkDetail } from "@oh-my-pi/pi-tui/chat/work-detail";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { TUI } from "@oh-my-pi/pi-tui/tui";

const cx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function thought(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: USAGE,
		timestamp: 1,
	};
}

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if (isNode(child)) out.push(...nodes(child));
	return out;
}

function section(message: AssistantMessageComponent): NativeNode {
	const found = nodes(message.describe(cx)).find(n => n.k === "section");
	if (!found) throw new Error("no thinking section");
	return found;
}

/** The folded live head's preview text, or undefined when the head carries none. */
function preview(message: AssistantMessageComponent): string | undefined {
	const node = nodes(section(message)).find(n => n.p?.role === "omp.thinking.preview");
	const spans = (node?.p as { spans?: { t: string }[] } | undefined)?.spans;
	return spans?.map(s => s.t).join("");
}

const disposables: { dispose(): void }[] = [];
function track<T extends { dispose(): void }>(component: T): T {
	disposables.push(component);
	return component;
}

/** A live (still streaming) thought. */
function liveThought(text: string, hideThinkingBlock = false): AssistantMessageComponent {
	const message = track(new AssistantMessageComponent(undefined, hideThinkingBlock));
	message.updateContent(thought(text), { transient: true });
	return message;
}

const WRITE_ARGS = {
	path: "src/a.ts",
	content: Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n"),
};

function write(): ToolExecutionComponent {
	return track(new ToolExecutionComponent("write", WRITE_ARGS, {}, undefined, ui));
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	for (const component of disposables.splice(0)) component.dispose();
	setWorkDetail("standard");
	stopSharedSpinnerTicker();
});

describe("work-detail mode: thinking", () => {
	const THREE_PARAGRAPHS = "**Plan** the fix\nwith detail\n\nCheck the parser\nthen the lexer\n\nNow the third";

	it("compact folds a live thought to a head that previews its latest finished paragraph, per paragraph", () => {
		setWorkDetail("compact");
		const message = liveThought(THREE_PARAGRAPHS);
		expect(section(message).p).toMatchObject({ role: "omp.thinking.live", collapsed: true });
		expect(preview(message)).toBe("Check the parser");

		// Tokens of the unfinished third paragraph do not move it; finishing that paragraph does.
		message.updateContent(thought(`${THREE_PARAGRAPHS} keeps growing`), { transient: true });
		expect(preview(message)).toBe("Check the parser");
		message.updateContent(thought(`${THREE_PARAGRAPHS} keeps growing\n\nFourth`), { transient: true });
		expect(preview(message)).toBe("Now the third keeps growing");
	});

	it("previews a first paragraph's ended first line, emphasis dropped, before any paragraph finishes", () => {
		setWorkDetail("compact");
		const message = liveThought("**Weighing** options\nstill in");
		expect(preview(message)).toBe("Weighing options");
		expect(preview(liveThought("no line has ended"))).toBeUndefined();
	});

	it("standard keeps a live thought open with no preview; verbose keeps a finished one open", () => {
		const live = liveThought(THREE_PARAGRAPHS);
		expect(section(live).p).toMatchObject({ collapsed: false });
		expect(preview(live)).toBeUndefined();

		const finished = track(new AssistantMessageComponent(thought(THREE_PARAGRAPHS)));
		expect(section(finished).p).toMatchObject({ role: "omp.thinking", collapsed: true });
		setWorkDetail("verbose");
		expect(section(finished).p).toMatchObject({ collapsed: false });
		setWorkDetail("compact");
		expect(section(finished).p).toMatchObject({ collapsed: true });
	});

	it("keeps the user's toggle over the mode until the mode changes again", () => {
		setWorkDetail("compact");
		const message = liveThought(THREE_PARAGRAPHS);
		message.handleNativeEvent({ type: "toggle", key: "k0", collapsed: false });
		expect(section(message).p).toMatchObject({ collapsed: false });
		// An open thought shows its body, so its head repeats none of it.
		expect(preview(message)).toBeUndefined();

		setWorkDetail("standard");
		setWorkDetail("compact");
		expect(section(message).p).toMatchObject({ collapsed: true });
	});

	it("shows no preview of a thought the user hid", () => {
		setWorkDetail("compact");
		const message = liveThought(THREE_PARAGRAPHS, true);
		expect(section(message).p).toMatchObject({ collapsed: true });
		expect(preview(message)).toBeUndefined();
	});
});

describe("work-detail mode: tool rows", () => {
	it("compact folds a streaming write to its head line, and verbose opens it", () => {
		setWorkDetail("compact");
		const tool = write();
		expect(tool.describe(cx).p).toMatchObject({ status: "pending", collapsed: true, preview: "none" });

		setWorkDetail("verbose");
		expect(tool.describe(cx).p).toMatchObject({ collapsed: false });
	});

	it("lets the user collapse a streaming write and a self-opening todo card in standard", () => {
		const tool = write();
		expect(tool.describe(cx).p).toMatchObject({ status: "pending", collapsed: false });
		tool.handleNativeEvent({ type: "toggle", key: "", collapsed: true });
		expect(tool.describe(cx).p).toMatchObject({ collapsed: true });
		tool.setArgsComplete("call-1");
		tool.setExecutionStarted("call-1");
		tool.updateResult({ content: [{ type: "text", text: "Wrote 40 lines" }], isError: false });
		tool.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(tool.describe(cx).p).toMatchObject({ status: "done", collapsed: false });

		const todo = track(new ToolExecutionComponent("todo", { op: "start", task: "lex" }, {}, undefined, ui));
		todo.setArgsComplete("call-2");
		todo.setExecutionStarted("call-2");
		todo.updateResult({
			content: [{ type: "text", text: "ok" }],
			details: {
				storage: "memory",
				phases: [{ name: "Build", tasks: [{ content: "lex", status: "in_progress" }] }],
			},
			isError: false,
		});
		expect(todo.describe(cx).p).toMatchObject({ collapsed: false });
		todo.handleNativeEvent({ type: "toggle", key: "", collapsed: true });
		expect(todo.describe(cx).p).toMatchObject({ collapsed: true });
		// Ctrl+O sets every row and replaces the per-row choice.
		todo.setExpanded(false);
		expect(todo.describe(cx).p).toMatchObject({ collapsed: false });
		// Compact folds even a card that opens itself; Ctrl+O still opens it.
		setWorkDetail("compact");
		expect(todo.describe(cx).p).toMatchObject({ collapsed: true });
		todo.setExpanded(true);
		expect(todo.describe(cx).p).toMatchObject({ collapsed: false });
	});

	it("drops a row's toggle once the mode changes", () => {
		setWorkDetail("compact");
		const tool = write();
		tool.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(tool.describe(cx).p).toMatchObject({ collapsed: false });
		setWorkDetail("verbose");
		setWorkDetail("compact");
		expect(tool.describe(cx).p).toMatchObject({ collapsed: true });
	});

	it("compact's folded bash row names its command in the head; an open one leaves it to the body", () => {
		setWorkDetail("compact");
		const tool = track(
			new ToolExecutionComponent("bash", { command: "\n  npm   test\nnpm run lint" }, {}, undefined, ui),
		);
		tool.setArgsComplete("call-4");
		expect(tool.describe(cx).p).toMatchObject({ collapsed: true, target: "npm test …", targetKind: "command" });
		tool.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect((tool.describe(cx).p as { target?: unknown }).target).toBeUndefined();
		setWorkDetail("standard");
		expect((tool.describe(cx).p as { target?: unknown }).target).toBeUndefined();
	});

	it("compact shows a folded failure's first error line in its head", () => {
		const failed = (mode: WorkDetail) => {
			setWorkDetail(mode);
			const tool = track(new ToolExecutionComponent("lookup_thing", { q: "x" }, {}, undefined, ui));
			tool.setArgsComplete("call-3");
			tool.setExecutionStarted("call-3");
			tool.updateResult({
				content: [{ type: "text", text: "\nError: upstream refused\tthe query\nstack line 1\nstack line 2" }],
				isError: true,
			});
			return tool.describe(cx).p;
		};
		expect(failed("compact")).toMatchObject({ status: "error", collapsed: true, note: "upstream refused the query" });
		expect((failed("standard") as { note?: unknown }).note).toBeUndefined();
	});
});

describe("work-detail mode: user runs", () => {
	function run(): BashExecutionComponent {
		const component = new BashExecutionComponent("npm test\nnpm run lint", ui as unknown as TUI);
		component.setComplete(0, false, { output: "ok" });
		return component;
	}

	it("a `!` run follows the mode like a tool row: compact folds it to its command, verbose opens it", () => {
		expect(run().describe(cx).p).toMatchObject({ collapsed: true, preview: "children" });
		expect((run().describe(cx).p as { target?: unknown }).target).toBeUndefined();

		setWorkDetail("compact");
		const folded = run();
		expect(folded.describe(cx).p).toMatchObject({
			collapsed: true,
			preview: "none",
			target: "npm test …",
			targetKind: "command",
		});
		folded.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(folded.describe(cx).p).toMatchObject({ collapsed: false });
		expect((folded.describe(cx).p as { target?: unknown }).target).toBeUndefined();

		setWorkDetail("verbose");
		expect(run().describe(cx).p).toMatchObject({ collapsed: false });
	});
});

describe("work-detail mode: task rows", () => {
	function progress(id: string, extra: Partial<AgentProgress>): AgentProgress {
		return {
			index: 0,
			id,
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: "Map the parser",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 10,
			cost: 0,
			durationMs: 1000,
			...extra,
		};
	}

	function taskRow(running: AgentProgress[], sealed = false): NativeNode {
		const tool = track(new ToolExecutionComponent("task", { agent: "explore", task: "Map" }, {}, undefined, ui));
		tool.setArgsComplete("call-t");
		tool.setExecutionStarted("call-t");
		const details: TaskToolDetails = { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: running };
		tool.updateResult({ content: [{ type: "text", text: "" }], details, isError: false }, true);
		if (sealed) tool.seal();
		return tool.describe(cx);
	}

	it("a folded running task row carries the live progress of its first running agent in its head", () => {
		setWorkDetail("compact");
		const row = taskRow([
			progress("Anna", { currentTool: "read", currentToolArgs: "src/lexer.ts" }),
			progress("Bob", { index: 1, stage: "Writing tests" }),
		]);
		expect(row.p).toMatchObject({ status: "running", collapsed: true, preview: "none" });
		expect((row.p as { meta?: unknown[] }).meta).toContain("2 running · Anna: read src/lexer.ts");

		// Between tool calls an agent's stage, else its last tool, stands in for the current tool.
		const idle = taskRow([
			progress("Bob", { stage: "Writing tests" }),
			progress("Cy", { status: "completed", index: 1 }),
		]);
		expect((idle.p as { meta?: unknown[] }).meta).toContain("Bob: Writing tests");
	});

	it("an aborted turn's sealed task row drops the live line its last progress frame carried", () => {
		setWorkDetail("compact");
		const row = taskRow([progress("Anna", { currentTool: "read", currentToolArgs: "src/lexer.ts" })], true);
		expect(row.p).toMatchObject({ status: "cancelled" });
		expect((row.p as { meta?: unknown[] }).meta ?? []).not.toContain("Anna: read src/lexer.ts");
	});
});

describe("work-detail mode: read groups", () => {
	function group(): ReadToolGroupComponent {
		const reads = new ReadToolGroupComponent();
		for (const [i, file] of ["/tmp/a.ts", "/tmp/b.ts"].entries()) {
			reads.updateArgs({ path: file }, `read-${i}`);
			reads.updateResult({ content: [{ type: "text", text: "line 1\nline 2" }] }, false, `read-${i}`);
		}
		return reads;
	}

	it("compact folds a multi-file read group to its head line; a click opens it", () => {
		const standard = group().describe(cx);
		expect(standard.p).toMatchObject({ collapsible: false });

		setWorkDetail("compact");
		const reads = group();
		expect(reads.describe(cx).p).toMatchObject({ collapsible: true, collapsed: true, preview: "none" });
		reads.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(reads.describe(cx).p).toMatchObject({ collapsed: false });
	});

	/** Two Markdown reads with content previews: each preview is its own collapsible card. */
	function markdownGroup(): ReadToolGroupComponent {
		const reads = new ReadToolGroupComponent({ showContentPreview: true });
		for (const [i, file] of ["/tmp/a.md", "/tmp/b.md"].entries()) {
			reads.updateArgs({ path: file }, `read-${i}`);
			reads.updateResult(
				{ content: [{ type: "text", text: "# Title\n\nbody" }], details: { contentType: "text/markdown" } },
				false,
				`read-${i}`,
			);
		}
		return reads;
	}

	function previewCard(reads: ReadToolGroupComponent, toolCallId: string): NativeNode {
		const found = nodes(reads.describe(cx)).find(n => n.k === "card" && n.key === `p${toolCallId}`);
		if (!found) throw new Error(`no preview card for ${toolCallId}`);
		return found;
	}

	it("standard clamps a folded group to a tool row's preview, and a file's own chevron opens that file", () => {
		const reads = markdownGroup();
		expect(reads.describe(cx).p).toMatchObject({ collapsed: true, preview: { lines: 10 } });
		expect(previewCard(reads, "read-0").p).toMatchObject({ collapsed: true });

		// The terminal reports the card's keypath under its file's section. The opened card lifts the
		// folded group's clamp (each card still clamps itself), so the card is not cut off by it.
		reads.handleNativeEvent({ type: "toggle", key: "pread-0/pread-0", collapsed: false });
		expect(previewCard(reads, "read-0").p).toMatchObject({ collapsed: false });
		expect(previewCard(reads, "read-1").p).toMatchObject({ collapsed: true });
		expect(reads.describe(cx).p).toMatchObject({ collapsed: true, preview: "children" });

		// Like a row's own toggle, it lapses when the mode changes, and the group clamp returns.
		setWorkDetail("verbose");
		setWorkDetail("standard");
		expect(previewCard(reads, "read-0").p).toMatchObject({ collapsed: true });
		expect(reads.describe(cx).p).toMatchObject({ preview: { lines: 10 } });
	});

	it("without the tool kind, verbose opens each file's preview card like the rest of verbose", () => {
		setWorkDetail("verbose");
		const reads = markdownGroup();
		const fallback = { ...cx, supports: (kind: string) => kind !== "tool" };
		const card = nodes(reads.describe(fallback)).find(n => n.k === "card" && n.key === "pread-0");
		expect(card?.p).toMatchObject({ collapsed: false });
	});
});

describe("work-detail mode: plain terminal", () => {
	it("leaves the row renderer's output unchanged in every mode", () => {
		const render = (mode: WorkDetail) => {
			setWorkDetail(mode);
			const message = liveThought("Plan the fix\n\nCheck the parser\n\nNow the third");
			const tool = write();
			const finished = track(new ToolExecutionComponent("lookup_thing", { q: "x" }, {}, undefined, ui));
			finished.setArgsComplete("call-4");
			finished.setExecutionStarted("call-4");
			finished.updateResult({ content: [{ type: "text", text: "row\n".repeat(30) }], isError: false });
			// Spinner glyphs follow the wall clock, not the mode.
			return [message, tool, finished].map(component =>
				component
					.render(80)
					.join("\n")
					.replace(/[\u2800-\u28ff]/g, "*"),
			);
		};
		const standard = render("standard");
		expect(render("compact")).toEqual(standard);
		expect(render("verbose")).toEqual(standard);
	});
});
