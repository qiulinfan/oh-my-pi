/**
 * Nested context files: the AGENTS.md / CLAUDE.md of directories below the
 * session's working directory, attached the first time a tool reaches them.
 *
 * The system prompt carries only the context files of the working directory
 * and its ancestors. When a read, edit, write or search targets a path below a
 * workspace root, every directory between that root and the target's directory
 * contributes the context files omp's discovery rules find in it (one per
 * directory, `.claude/CLAUDE.md` and `contextFiles.extra` names included). Each
 * file is delivered once as a developer message after the tool results — the
 * append-only passive-context channel TTSR reminders use — so the cached prompt
 * prefix is never rewritten.
 *
 * "Once" is decided against the live conversation, not a side table: a file
 * counts as delivered while a developer message carrying its marker is still in
 * context. Compaction that summarizes the message away therefore makes the
 * next tool call in that directory deliver it again, and a resumed session
 * sees what its restored transcript already holds.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { FileType, listWorkspace } from "@oh-my-pi/pi-natives";
import {
	logger,
	normalizePathForComparison,
	prompt,
	relativePathWithinNormalizedRoot,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils";
import nestedContextTemplate from "../prompts/system/nested-context.md" with { type: "text" };
import { loadProjectContextFiles } from "../system-prompt";
import { approvalTreeSearchFolderKey } from "../tools/approval-targets";

/** Characters of one file attached before it is truncated. */
const NESTED_CONTEXT_FILE_CHARS = 20_000;
/** Characters attached across all files of one tool batch. */
const NESTED_CONTEXT_BATCH_CHARS = 40_000;
/** Below this remaining budget a file is named instead of cut to a sliver. */
const MIN_ATTACHED_CHARS = 1_000;
/** Bounds the one-level directory listing used for the ignore check. */
const LISTING_TIMEOUT_MS = 2_000;

const MARKER = /<system-reminder reason="directory-rules" path="([^"\n]*)">/g;

interface NestedContextFile {
	path: string;
	/** Directory whose rules the file holds (a `.claude/CLAUDE.md` belongs to the directory above `.claude`). */
	dir: string;
	content: string;
}

interface RenderedFile {
	path: string;
	dir: string;
	content?: string;
	omitted?: boolean;
	truncated?: boolean;
	shownChars?: number;
	totalChars?: number;
}

/** Paths of nested context files whose delivery is still in `messages`. */
function deliveredNestedContextPaths(messages: readonly AgentMessage[]): Set<string> {
	const delivered = new Set<string>();
	for (const message of messages) {
		if (message.role !== "developer") continue;
		const content = message.content;
		const texts =
			typeof content === "string"
				? [content]
				: content.flatMap(block => (block.type === "text" ? [block.text] : []));
		for (const text of texts) {
			for (const match of text.matchAll(MARKER)) delivered.add(match[1]!);
		}
	}
	return delivered;
}

/**
 * The directory a tool target names: approval-cache keys spell a folder with a
 * trailing separator (a recursive search as an opaque tree key over one), and
 * a file — existing or about to be written — without. Non-filesystem targets
 * (internal and web URLs) name none.
 */
function targetDirectory(target: string): string | undefined {
	const folder = approvalTreeSearchFolderKey(target) ?? target;
	if (!path.isAbsolute(folder)) return undefined;
	if (folder.length > 1 && (folder.endsWith("/") || folder.endsWith(path.sep))) return folder.slice(0, -1);
	return path.dirname(folder);
}

export class NestedContextLoader {
	/**
	 * Files claimed by calls of the current batch, whose developer message has
	 * not reached the conversation yet. A batch is one assistant message's tool
	 * calls; by the next one, the previous batch's message is in context.
	 */
	readonly #reserved = new Set<string>();
	#batch: object | undefined;
	/** Directory → whether the workspace walker would enter it (not hidden, ignored or pruned). */
	readonly #visible = new Map<string, Promise<boolean>>();
	/** Directory → the context files discovery found in it. */
	readonly #files = new Map<string, NestedContextFile[]>();

	/**
	 * Context to attach for a tool call reaching `targets`, or undefined when
	 * every context file between the roots and those targets is already in
	 * `messages` (or claimed by another call of `batch`, the assistant message
	 * that issued the call).
	 */
	async contextFor(
		targets: readonly string[],
		roots: readonly string[],
		messages: readonly AgentMessage[],
		batch: object,
	): Promise<string | undefined> {
		const normalizedRoots = roots.map(root => normalizePathForComparison(root));
		const reached = new Set<string>();
		for (const target of targets) {
			const dir = targetDirectory(target);
			if (dir === undefined) continue;
			this.#forgetEdited(target);
			// Root down, stopping at the first directory the walker skips: an ignored or pruned
			// directory hides everything below it, as it does for the `<dir-context>` index.
			for (const chainDir of this.#chain(normalizePathForComparison(dir), normalizedRoots)) {
				if (!(await this.#isVisible(chainDir))) break;
				reached.add(chainDir);
			}
		}
		if (reached.size === 0) return undefined;

		const candidates: NestedContextFile[] = [];
		for (const dir of [...reached].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
			candidates.push(...(await this.#filesIn(dir)));
		}
		if (candidates.length === 0) return undefined;

		// Decide and claim with no await in between, so concurrent calls of one batch never attach a file twice.
		if (this.#batch !== batch) {
			this.#batch = batch;
			this.#reserved.clear();
		}
		const delivered = deliveredNestedContextPaths(messages);
		const fresh = candidates.filter(file => !delivered.has(file.path) && !this.#reserved.has(file.path));
		if (fresh.length === 0) return undefined;
		for (const file of fresh) this.#reserved.add(file.path);
		return prompt.render(nestedContextTemplate, { files: budget(fresh) });
	}

	/** Directories strictly below the deepest root holding `dir`, down to `dir` itself. */
	#chain(dir: string, roots: readonly string[]): string[] {
		let root: string | undefined;
		let relative: string | null = null;
		for (const candidate of roots) {
			const rel = relativePathWithinNormalizedRoot(candidate, dir);
			if (rel === null || (root !== undefined && candidate.length <= root.length)) continue;
			root = candidate;
			relative = rel;
		}
		if (root === undefined || !relative) return [];
		const chain: string[] = [];
		let current = root;
		for (const segment of relative.split(path.sep)) {
			current = path.join(current, segment);
			chain.push(current);
		}
		return chain;
	}

	/**
	 * Whether the workspace walker that builds the `<dir-context>` index enters
	 * `dir`: listed by its parent with gitignore rules applied, hidden entries
	 * skipped and non-source directories (`node_modules`, `dist`, …) pruned.
	 */
	#isVisible(dir: string): Promise<boolean> {
		let cached = this.#visible.get(dir);
		if (!cached) {
			const parent = path.dirname(dir);
			const name = path.basename(dir);
			cached = listWorkspace({
				path: parent,
				maxDepth: 1,
				hidden: false,
				gitignore: true,
				timeoutMs: LISTING_TIMEOUT_MS,
			})
				.then(result => result.entries.some(entry => entry.fileType === FileType.Dir && entry.path === name))
				.catch(error => {
					logger.debug("Nested context: directory listing failed", { dir: parent, error: String(error) });
					return false;
				});
			this.#visible.set(dir, cached);
		}
		return cached;
	}

	async #filesIn(dir: string): Promise<NestedContextFile[]> {
		const cached = this.#files.get(dir);
		if (cached) return cached;
		let files: NestedContextFile[] = [];
		try {
			files = (await loadProjectContextFiles({ cwd: dir }))
				.filter(file => file.depth === 0)
				.map(file => ({ path: resolveEquivalentPath(file.path), dir, content: file.content }))
				.filter(file => relativePathWithinNormalizedRoot(dir, file.path) !== null);
		} catch (error) {
			logger.debug("Nested context: context-file discovery failed", { dir, error: String(error) });
		}
		this.#files.set(dir, files);
		return files;
	}

	/** A call that targets a context file itself may have changed it: rediscover its directory next time. */
	#forgetEdited(target: string): void {
		for (const [dir, files] of this.#files) {
			if (files.some(file => file.path === target)) this.#files.delete(dir);
		}
	}
}

/** Shallowest first, each file capped, the batch capped; files past the batch budget are named, not attached. */
function budget(files: readonly NestedContextFile[]): RenderedFile[] {
	let remaining = NESTED_CONTEXT_BATCH_CHARS;
	return files.map(file => {
		const { dir } = file;
		const allowed = Math.min(NESTED_CONTEXT_FILE_CHARS, remaining);
		if (allowed < Math.min(MIN_ATTACHED_CHARS, file.content.length)) return { path: file.path, dir, omitted: true };
		const shown = file.content.length > allowed ? file.content.slice(0, allowed) : file.content;
		remaining -= shown.length;
		return shown.length < file.content.length
			? {
					path: file.path,
					dir,
					content: shown,
					truncated: true,
					shownChars: shown.length,
					totalChars: file.content.length,
				}
			: { path: file.path, dir, content: shown };
	});
}
