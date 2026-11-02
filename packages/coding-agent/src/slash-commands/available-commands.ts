import type { AvailableCommand } from "@oh-my-pi/pi-utils/acp";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { SkillsSettings } from "../extensibility/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import {
	getSkillSlashCommandName,
	type ParsedSkillInvocation,
	parseBareSkillInvocation,
	parseSkillInvocation,
	type Skill,
} from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { ACP_BUILTIN_RESERVED_NAMES, isAcpBuiltinShadowedName } from "./acp-builtins";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "./builtin-registry";

export type AvailableSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

export interface InternalAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface AvailableCommandsSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly mcpPromptCommands?: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
	readonly effectiveExtensionRoots?: EffectiveExtensionRoots;
	setSlashCommands(slashCommands: FileSlashCommand[]): void;
	sessionManager: { getCwd(): string };
}

/** Session state that decides which command owns a `/<name>` token on ACP and RPC. */
export type SkillCommandSession = Pick<
	AvailableCommandsSession,
	"extensionRunner" | "customCommands" | "mcpPromptCommands" | "skills" | "skillsSettings"
> & { readonly slashCommands: ReadonlyArray<Pick<FileSlashCommand, "name">> };

/** Whether a builtin, extension, custom, MCP prompt, or file command holds `name`, so `/<name>` is not a skill. */
function isSkillNameShadowed(session: SkillCommandSession, name: string): boolean {
	return (
		ACP_BUILTIN_RESERVED_NAMES.has(name) ||
		session.extensionRunner?.getCommand(name) !== undefined ||
		session.customCommands.some(loaded => loaded.command.name === name) ||
		(session.mcpPromptCommands ?? []).some(loaded => loaded.command.name === name) ||
		session.slashCommands.some(command => command.name === name)
	);
}

/** The slash command a skill is advertised under: `/<name>`, or `/skill:<name>` when another command holds the name. */
function skillCommandName(session: SkillCommandSession, skill: Skill): string {
	return isSkillNameShadowed(session, skill.name) ? getSkillSlashCommandName(skill) : skill.name;
}

/**
 * Resolve `text` to a skill invocation on ACP and RPC: `/skill:<name>` (leading or mid-prompt),
 * or a leading `/<name>` naming a skill no other command shadows.
 */
export function resolveSkillCommandInvocation(
	session: SkillCommandSession,
	text: string,
): { skill: Skill; parsed: ParsedSkillInvocation } | undefined {
	if (!session.skillsSettings?.enableSkillCommands) return undefined;
	const parsed = parseSkillInvocation(text);
	if (parsed) {
		const skill = session.skills.find(candidate => candidate.name === parsed.name);
		return skill && { skill, parsed };
	}
	const bare = parseBareSkillInvocation(text);
	if (!bare || isSkillNameShadowed(session, bare.name)) return undefined;
	const skill = session.skills.find(candidate => candidate.name === bare.name);
	return skill && { skill, parsed: bare };
}

export async function buildAvailableSlashCommands(
	session: AvailableCommandsSession,
	loadFileCommands: (cwd: string) => Promise<FileSlashCommand[]> = cwd =>
		loadSlashCommands({ cwd, extensionRoots: session.effectiveExtensionRoots }),
): Promise<InternalAvailableSlashCommand[]> {
	const commands: InternalAvailableSlashCommand[] = [];
	const seenNames = new Set<string>();
	const appendCommand = (command: InternalAvailableSlashCommand): void => {
		if (seenNames.has(command.name)) return;
		seenNames.add(command.name);
		commands.push(command);
	};

	for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
		if (!command.handle) continue;
		const hint = command.acpInputHint ?? command.inlineHint;
		appendCommand({
			name: command.name,
			aliases: command.aliases,
			description: command.acpDescription ?? command.description,
			input: hint ? { hint } : undefined,
			subcommands: command.subcommands,
			source: "builtin",
		});
		// ACP dispatch resolves builtin aliases before `session.prompt()` sees the
		// input, so a custom/file command sharing an alias would be advertised but
		// never run. Reserve aliases here too; TUI-only builtins are skipped above,
		// so their aliases stay available.
		for (const alias of command.aliases ?? []) seenNames.add(alias);
	}

	const runner = session.extensionRunner;
	if (runner) {
		for (const command of runner.getRegisteredCommands(ACP_BUILTIN_RESERVED_NAMES)) {
			if (isAcpBuiltinShadowedName(command.name)) continue;
			appendCommand({
				name: command.name,
				description: command.description ?? "(extension command)",
				input: { hint: "arguments" },
				source: "extension",
			});
		}
	}

	for (const command of session.customCommands) {
		const source: AvailableSlashCommandSource = command.path?.startsWith("mcp:") ? "mcp_prompt" : "custom";
		appendCommand({
			name: command.command.name,
			description: command.command.description,
			input: { hint: "arguments" },
			source,
		});
	}

	const fileCommands = await loadFileCommands(session.sessionManager.getCwd());
	session.setSlashCommands(fileCommands);
	for (const command of fileCommands) {
		appendCommand({
			name: command.name,
			description: command.description,
			input: command.argumentHint ? { hint: command.argumentHint } : undefined,
			source: "file",
		});
	}

	// Skills come last: a skill takes `/<name>` only when no command above holds it.
	if (session.skillsSettings?.enableSkillCommands) {
		// Explicit fields: a spread would drop AgentSession's prototype getters.
		const shadowSession: SkillCommandSession = {
			extensionRunner: session.extensionRunner,
			customCommands: session.customCommands,
			mcpPromptCommands: session.mcpPromptCommands,
			skills: session.skills,
			skillsSettings: session.skillsSettings,
			slashCommands: fileCommands,
		};
		for (const skill of session.skills) {
			appendCommand({
				name: skillCommandName(shadowSession, skill),
				description: skill.description || `Run ${skill.name} skill`,
				input: { hint: "arguments" },
				source: "skill",
			});
		}
	}

	return commands;
}

export function toAcpAvailableCommands(commands: readonly InternalAvailableSlashCommand[]): AvailableCommand[] {
	return commands.map(command => ({
		name: command.name,
		description: command.description ?? "",
		input: command.input,
	}));
}
