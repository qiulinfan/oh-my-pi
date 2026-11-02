/**
 * The start page's slash command list. omp runs a slash command only from a
 * session's composer, and no omp runs behind the start page, so the page shows
 * the commands the GUI server lists for the chosen project (`/api/commands`)
 * and starts the session only when the command is sent.
 */

/** A slash command as `/api/commands` lists it. */
export interface SlashCommandInfo {
	name: string;
	description?: string;
	hint?: string;
}

/** The command name being typed: the text is `/` and a name with no space yet; null otherwise. */
export function slashQuery(text: string): string | null {
	const match = /^\/(\S*)$/.exec(text);
	return match ? match[1]! : null;
}

/** Commands whose name starts with `query`, then those containing it, each group in listed order. */
export function matchCommands(commands: readonly SlashCommandInfo[], query: string): SlashCommandInfo[] {
	const lower = query.toLowerCase();
	const starts = commands.filter(command => command.name.toLowerCase().startsWith(lower));
	const contains = commands.filter(
		command => !command.name.toLowerCase().startsWith(lower) && command.name.toLowerCase().includes(lower),
	);
	return [...starts, ...contains];
}
