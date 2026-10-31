/**
 * Agent presets: named launch configurations for the main session.
 *
 * A preset is a Markdown file in `.omp/presets/` (project) or
 * `~/.omp/agent/presets/` (user); its file name is the preset name, and a
 * project preset shadows a user preset of the same name. The frontmatter picks
 * the model, thinking level, skills, tools and approval mode, and can leave out
 * the user-level context files (the global AGENTS.md); the body is appended to
 * the system prompt. `omp --preset <name>` applies it as defaults for the
 * matching flags: a flag given on the command line still wins. The `agentPreset`
 * setting names the preset a session starts from when the command line names
 * none, so a project's config.yml can give it a default; `--no-preset` opts out.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { type ConfiguredThinkingLevel, parseCliThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Args } from "../cli/args";
import { cfgAgentPreset } from "../session/settings";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { parseArrayOrCSV, parseBoolean } from "../discovery/helpers";
import { type ApprovalMode, isApprovalMode } from "../tools/approval";
import { normalizeToolNames } from "../tools/builtin-names";
import type { Settings } from "./settings";

const PRESET_CONFIG_SOURCE = ".omp";
const PRESET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

/** Whether `value` can name a preset: a letter, then letters, digits, `-` or `_`. */
export function isAgentPresetName(value: unknown): value is string {
	return typeof value === "string" && PRESET_NAME_PATTERN.test(value);
}

export interface AgentPreset {
	name: string;
	description?: string;
	filePath: string;
	source: "project" | "user";
	model?: string;
	thinking?: ConfiguredThinkingLevel;
	/** Skill globs to expose; an empty list exposes no skills. Absent keeps the configured skills. */
	skills?: string[];
	tools?: string[];
	approvalMode?: ApprovalMode;
	/** False leaves out user-level context files such as `~/.omp/agent/AGENTS.md`. */
	userContext: boolean;
	/** Appended to the system prompt in place of a discovered APPEND_SYSTEM.md. */
	prompt?: string;
}

/** Parse one preset file; throws with the file path when a field is malformed. */
export function parseAgentPreset(filePath: string, content: string, source: AgentPreset["source"]): AgentPreset {
	const name = path.basename(filePath, ".md");
	const fail = (message: string): never => {
		throw new Error(`Invalid preset ${filePath}: ${message}`);
	};
	if (!isAgentPresetName(name)) fail("the file name must start with a letter and use letters, digits, - or _");
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath, level: "fatal" });
	const preset: AgentPreset = { name, filePath, source, userContext: true };

	if (frontmatter.description !== undefined) {
		if (typeof frontmatter.description !== "string") fail("description must be a string");
		preset.description = frontmatter.description as string;
	}
	if (frontmatter.model !== undefined) {
		if (typeof frontmatter.model !== "string" || !frontmatter.model.trim()) fail("model must be a model selector");
		preset.model = (frontmatter.model as string).trim();
	}
	const rawThinking = frontmatter.thinking ?? frontmatter.thinkingLevel;
	if (rawThinking !== undefined) {
		const thinking = typeof rawThinking === "string" ? parseCliThinkingLevel(rawThinking) : undefined;
		if (thinking === undefined) fail(`unknown thinking level ${JSON.stringify(rawThinking)}`);
		preset.thinking = thinking;
	}
	if (frontmatter.skills !== undefined && frontmatter.skills !== null) {
		const skills = parseArrayOrCSV(frontmatter.skills);
		const empty = Array.isArray(frontmatter.skills) && frontmatter.skills.length === 0;
		if (!skills && !empty) fail("skills must be a list or comma-separated skill names");
		preset.skills = skills ?? [];
	}
	if (frontmatter.tools !== undefined && frontmatter.tools !== null) {
		const tools = parseArrayOrCSV(frontmatter.tools);
		if (!tools) fail("tools must name at least one tool");
		preset.tools = normalizeToolNames(tools as string[]);
	}
	if (frontmatter.approvalMode !== undefined) {
		if (!isApprovalMode(frontmatter.approvalMode))
			fail(`unknown approval-mode ${JSON.stringify(frontmatter.approvalMode)}`);
		preset.approvalMode = frontmatter.approvalMode as ApprovalMode;
	}
	if (frontmatter.userContext !== undefined) {
		const userContext = parseBoolean(frontmatter.userContext);
		if (userContext === undefined) fail("user-context must be true or false");
		preset.userContext = userContext as boolean;
	}
	const prompt = body.trim();
	if (prompt) preset.prompt = prompt;
	return preset;
}

function presetDirs(cwd: string): Array<{ dir: string; source: AgentPreset["source"] }> {
	const dirs: Array<{ dir: string; source: AgentPreset["source"] }> = [];
	const project = findAllNearestProjectConfigDirs("presets", path.resolve(cwd)).find(
		entry => entry.source === PRESET_CONFIG_SOURCE,
	);
	if (project) dirs.push({ dir: project.path, source: "project" });
	const user = getConfigDirs("presets", { project: false }).find(entry => entry.source === PRESET_CONFIG_SOURCE);
	if (user) dirs.push({ dir: user.path, source: "user" });
	return dirs;
}

async function presetFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.map(entry => path.join(dir, entry.name))
		.sort();
}

/** Every preset visible from `cwd`, project before user; a malformed file is skipped with a warning. */
export async function discoverAgentPresets(cwd: string): Promise<AgentPreset[]> {
	const presets: AgentPreset[] = [];
	const seen = new Set<string>();
	for (const { dir, source } of presetDirs(cwd)) {
		for (const filePath of await presetFiles(dir)) {
			try {
				const preset = parseAgentPreset(filePath, await Bun.file(filePath).text(), source);
				if (seen.has(preset.name)) continue;
				seen.add(preset.name);
				presets.push(preset);
			} catch (error) {
				logger.warn("Skipping agent preset", { filePath, error: String(error) });
			}
		}
	}
	return presets;
}

/** The preset `name` resolves to from `cwd`; throws when there is none or its file is malformed. */
export async function loadAgentPreset(name: string, cwd: string): Promise<AgentPreset> {
	const dirs = presetDirs(cwd);
	for (const { dir, source } of dirs) {
		const filePath = path.join(dir, `${name}.md`);
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch {
			continue;
		}
		return parseAgentPreset(filePath, content, source);
	}
	const known = (await discoverAgentPresets(cwd)).map(preset => preset.name);
	const searched = dirs.map(entry => entry.dir).join(", ");
	throw new Error(
		`Unknown preset ${JSON.stringify(name)}. ${known.length > 0 ? `Available: ${known.join(", ")}.` : `No presets in ${searched}.`}`,
	);
}

/** Fill the flags the command line left unset from the preset. */
export function applyAgentPreset(args: Args, preset: AgentPreset): void {
	if (preset.model !== undefined && args.model === undefined && args.models === undefined) args.model = preset.model;
	if (preset.thinking !== undefined) args.thinking ??= preset.thinking;
	if (preset.skills !== undefined && args.skills === undefined && !args.noSkills) {
		if (preset.skills.length === 0) args.noSkills = true;
		else args.skills = preset.skills;
	}
	if (preset.tools !== undefined && args.tools === undefined && !args.noTools) args.tools = preset.tools;
	if (preset.approvalMode !== undefined && args.approvalMode === undefined && !args.autoApprove) {
		args.approvalMode = preset.approvalMode;
	}
	if (!preset.userContext) args.noUserContextFiles = true;
	// A trailing newline keeps resolvePromptInput from reading a one-line prompt as a file path.
	if (preset.prompt !== undefined) args.appendSystemPrompt ??= `${preset.prompt}\n`;
}

/** The preset name the `agentPreset` setting gives, or undefined when it names none. */
export function defaultAgentPresetName(settings: Settings): string | undefined {
	return cfgAgentPreset.get(settings).trim() || undefined;
}

/**
 * The preset a launch starts from: `--preset`, else the `agentPreset` setting, unless `--no-preset`.
 * Throws when the name resolves to no preset or a malformed one.
 */
export async function resolveLaunchPreset(
	args: Args,
	settings: Settings,
	cwd: string,
): Promise<AgentPreset | undefined> {
	if (args.noPreset) {
		if (args.preset !== undefined) throw new Error("--preset and --no-preset cannot be combined");
		return undefined;
	}
	if (args.preset !== undefined) return loadAgentPreset(args.preset, cwd);
	const name = defaultAgentPresetName(settings);
	if (name === undefined) return undefined;
	try {
		return await loadAgentPreset(name, cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message} (named by the agentPreset setting; --no-preset starts without it)`);
	}
}
