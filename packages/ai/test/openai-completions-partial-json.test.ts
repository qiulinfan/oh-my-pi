// Live tool previews (write/edit/eval bodies, bash commands) pace and decode the
// raw streamed argument JSON exposed through `getStreamingPartialJson`. The
// openai-completions provider refreshes `arguments` only through a throttled
// re-parse (≥256 bytes of growth), so without the raw buffer the previews jump
// in ~256-character bursts on every OpenAI-compatible host (DeepSeek, OpenRouter, …).
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ToolCall } from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson, isStreamingPartialJsonDisplayOnly } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseStreamingJson } from "@oh-my-pi/pi-utils";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

const context: Context = {
	messages: [{ role: "user", content: "Write the file", timestamp: Date.now() }],
	tools: [
		{
			name: "write",
			description: "Write a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
			},
		},
	],
};

function chunk(extra: Record<string, unknown>): string {
	return JSON.stringify({
		id: "chatcmpl-partial-json",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	});
}

function argumentChunk(args: string, first: boolean): string {
	const call = first
		? { index: 0, id: "call_write", type: "function", function: { name: "write", arguments: args } }
		: { index: 0, function: { arguments: args } };
	return chunk({ choices: [{ index: 0, delta: { tool_calls: [call] } }] });
}

/**
 * Serves SSE chunks one at a time: every chunk after the first argument chunk
 * waits for `release()`, so the test observes the block exactly as each
 * `toolcall_delta` left it instead of after the provider read ahead.
 */
function gatedSse(argumentPieces: string[], ending: "finish" | "error") {
	const chunks = argumentPieces.map((piece, index) => argumentChunk(piece, index === 0));
	if (ending === "finish") {
		chunks.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }), "[DONE]");
	}
	const encoder = new TextEncoder();
	let pending = Promise.withResolvers<void>();
	const release = () => {
		pending.resolve();
	};
	let next = 0;
	const fetch: FetchImpl = async () => {
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (next > 0) {
					await pending.promise;
					pending = Promise.withResolvers<void>();
				}
				if (next >= chunks.length) {
					if (ending === "error") controller.error(new Error("connection reset mid tool call"));
					else controller.close();
					return;
				}
				controller.enqueue(encoder.encode(`data: ${chunks[next++]}\n\n`));
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, release };
}

function splitEvery(text: string, size: number): string[] {
	const pieces: string[] = [];
	for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
	return pieces;
}

const content = Array.from({ length: 40 }, (_, line) => `line ${line}: ${"x".repeat(24)}`).join("\n");
const rawArguments = JSON.stringify({ path: "notes.md", content });

describe("openai-completions streamed tool-call partial JSON", () => {
	it("exposes the raw argument buffer on every delta, ahead of the throttled parse, and clears it at the end", async () => {
		const pieces = splitEvery(rawArguments, 12);
		const { fetch, release } = gatedSse(pieces, "finish");
		const stream = streamOpenAICompletions(completionsModel, context, { apiKey: "test-key", fetch });

		let streamed = "";
		let deltas = 0;
		let argumentsLagged = false;
		let endedCall: ToolCall | undefined;
		for await (const event of stream) {
			if (event.type === "toolcall_delta") {
				deltas++;
				streamed += event.delta;
				const block = event.partial.content[event.contentIndex] as ToolCall;
				expect(getStreamingPartialJson(block)).toBe(streamed);
				// Stream speculation (task launch, eval shadows) must not plan from this buffer.
				expect(isStreamingPartialJsonDisplayOnly(block)).toBe(true);
				// Compare decoded content with decoded content: once the `content` value has
				// opened, a throttled `arguments` holds a strictly shorter prefix of it.
				const streamedContent = parseStreamingJson<{ content?: string }>(streamed).content;
				const parsedContent = block.arguments.content;
				if (
					typeof streamedContent === "string" &&
					streamedContent.length > 0 &&
					(typeof parsedContent !== "string" || parsedContent.length < streamedContent.length)
				) {
					argumentsLagged = true;
				}
				release();
			} else if (event.type === "toolcall_end") {
				endedCall = event.toolCall;
				expect(getStreamingPartialJson(event.toolCall)).toBeUndefined();
				release();
			}
		}
		const message = await stream.result();

		expect(deltas).toBe(pieces.length);
		// The throttle really held `arguments` back somewhere, so the raw buffer was the fresher channel.
		expect(argumentsLagged).toBe(true);
		expect(endedCall?.arguments).toEqual({ path: "notes.md", content });
		const call = message.content.find(block => block.type === "toolCall");
		expect(call && getStreamingPartialJson(call)).toBeUndefined();
	});

	// The error path closes every pending call through `finishOpenBlocksOnError`;
	// a rebuilt transcript must read the final `arguments`, not the raw buffer.
	it("leaves no stale partial buffer on a tool call cut off by a stream error", async () => {
		const pieces = splitEvery(rawArguments.slice(0, 300), 25);
		const { fetch, release } = gatedSse(pieces, "error");
		const stream = streamOpenAICompletions(completionsModel, context, { apiKey: "test-key", fetch });

		let sawPartial = false;
		for await (const event of stream) {
			if (event.type === "toolcall_delta") {
				if (getStreamingPartialJson(event.partial.content[event.contentIndex] as ToolCall)) sawPartial = true;
				release();
			}
		}
		const message = await stream.result();

		expect(sawPartial).toBe(true);
		expect(message.stopReason).toBe("error");
		const call = message.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("Expected the cut-off tool call to stay in the message");
		expect(getStreamingPartialJson(call)).toBeUndefined();
	});
});
