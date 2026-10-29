/**
 * What the GUI's Settings page reads and writes beyond omp's settings panel: the global
 * instructions file every session loads, and the models assigned to the chat roles.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { MODEL_ROLES } from "../config/model-roles";
import { cfgModelRoles } from "../config/model-settings";
import { Settings } from "../config/settings";

export interface Instructions {
	/** Where omp reads it: `AGENTS.md` in the agent directory. */
	path: string;
	/** The file a symlink at `path` points to, which a save writes; absent when `path` is the file itself. */
	target?: string;
	text: string;
}

function instructionsPath(): string {
	return path.join(getAgentDir(), "AGENTS.md");
}

/** The file a save writes: through a symlink to the file it names, so a linked-in file stays linked. */
async function writeTarget(file: string): Promise<string> {
	try {
		return await fs.realpath(file);
	} catch (err) {
		if (isEnoent(err)) return file;
		throw err;
	}
}

export async function readInstructions(): Promise<Instructions> {
	const file = instructionsPath();
	const target = await writeTarget(file);
	let text = "";
	try {
		text = await Bun.file(target).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	return { path: file, target: target === file ? undefined : target, text };
}

/**
 * Save `text` when the file still holds `base`, the text the page loaded; false, leaving it, when it
 * changed meanwhile, so an edit made elsewhere is never overwritten unseen.
 */
export async function writeInstructions(text: string, base: string): Promise<boolean> {
	const current = await readInstructions();
	if (current.text !== base) return false;
	await Bun.write(current.target ?? current.path, text);
	return true;
}

export interface RoleChoice {
	id: string;
	name: string;
	/** The role's model selector in the global config (`provider/id`, maybe with `:level`); null when unset. */
	value: string | null;
}

/** omp's global settings, loaded once from the home directory so no project layer applies. */
function globalSettings(): Promise<Settings> {
	return Settings.init({ cwd: os.homedir() });
}

/** The chat roles, in omp's order, with the model each is set to. */
export async function readModelRoles(): Promise<RoleChoice[]> {
	const roles = cfgModelRoles.get(await globalSettings());
	return Object.entries(MODEL_ROLES)
		.filter(([, info]) => info.section === "chat")
		.map(([id, info]) => ({ id, name: info.name, value: roles[id] ?? null }));
}

/** Set a chat role's model (null clears it), the way omp's model hub does, and wait for config.yml. */
export async function writeModelRole(role: string, value: string | null): Promise<boolean> {
	if (MODEL_ROLES[role as keyof typeof MODEL_ROLES]?.section !== "chat") return false;
	const settings = await globalSettings();
	settings.setModelRole(role, value ?? undefined);
	await settings.flush();
	return true;
}

/** The default role's model, which a new session without a pick starts on. */
export async function defaultModelRole(): Promise<string | null> {
	return cfgModelRoles.get(await globalSettings()).default ?? null;
}
