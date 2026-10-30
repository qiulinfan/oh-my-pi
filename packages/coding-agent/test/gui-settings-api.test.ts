import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest } from "../src/config/settings";
import {
	readGuiPrefs,
	readInstructions,
	readModelRoles,
	writeGuiPref,
	writeInstructions,
	writeModelRole,
} from "../src/gui/settings-api";

describe("omp gui: global instructions", () => {
	let previous: string;
	let root: string;
	let agentDir: string;

	beforeEach(async () => {
		previous = getAgentDir();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-instructions-"));
		agentDir = path.join(root, "agent");
		await fs.mkdir(agentDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		setAgentDir(previous);
		await removeWithRetries(root);
	});

	test("a save through a linked AGENTS.md writes the file it links to and keeps the link", async () => {
		const source = path.join(root, "guidance.md");
		await Bun.write(source, "old\n");
		const link = path.join(agentDir, "AGENTS.md");
		await fs.symlink(source, link);

		const loaded = await readInstructions();
		expect(loaded).toEqual({ path: link, target: await fs.realpath(source), text: "old\n" });
		expect(await writeInstructions("new\n", loaded.text)).toBe(true);

		expect(await Bun.file(source).text()).toBe("new\n");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	test("a save over a file changed since it was read leaves the file alone", async () => {
		const file = path.join(agentDir, "AGENTS.md");
		await Bun.write(file, "first\n");
		const loaded = await readInstructions();
		await Bun.write(file, "changed elsewhere\n");

		expect(await writeInstructions("mine\n", loaded.text)).toBe(false);
		expect(await Bun.file(file).text()).toBe("changed elsewhere\n");
	});

	test("with no AGENTS.md yet, a save creates it in the agent directory", async () => {
		const loaded = await readInstructions();
		expect(loaded.text).toBe("");
		expect(await writeInstructions("hello\n", "")).toBe(true);
		expect(await Bun.file(path.join(agentDir, "AGENTS.md")).text()).toBe("hello\n");
	});
});

describe("omp gui: model roles", () => {
	let previous: string;
	let agentDir: string;

	beforeEach(async () => {
		previous = getAgentDir();
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-roles-"));
		setAgentDir(agentDir);
		resetSettingsForTest();
	});

	afterEach(async () => {
		resetSettingsForTest();
		setAgentDir(previous);
		await removeWithRetries(agentDir);
	});

	test("a role set on the page lands in config.yml and reads back; clearing it removes it", async () => {
		expect(await writeModelRole("smol", "anthropic/claude-haiku-5-5:low")).toBe(true);
		const config = Bun.YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
			modelRoles?: Record<string, string>;
		};
		expect(config.modelRoles).toEqual({ smol: "anthropic/claude-haiku-5-5:low" });
		expect((await readModelRoles()).find(role => role.id === "smol")?.value).toBe("anthropic/claude-haiku-5-5:low");

		expect(await writeModelRole("smol", null)).toBe(true);
		expect((await readModelRoles()).find(role => role.id === "smol")?.value).toBeNull();
	});

	test("only chat roles are offered or written", async () => {
		const ids = (await readModelRoles()).map(role => role.id);
		expect(ids).toContain("default");
		expect(ids).not.toContain("web");
		expect(await writeModelRole("web", "x/y")).toBe(false);
		expect(await writeModelRole("no-such-role", "x/y")).toBe(false);
	});
});

describe("omp gui: page preferences", () => {
	let previous: string;
	let root: string;
	let agentDir: string;

	beforeEach(async () => {
		previous = getAgentDir();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-prefs-"));
		agentDir = path.join(root, "agent");
		await fs.mkdir(agentDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		setAgentDir(previous);
		await removeWithRetries(root);
	});

	test("two windows saving at once both keep their preference, and an empty value clears one", async () => {
		expect(
			await Promise.all([writeGuiPref("theme", "dark"), writeGuiPref("model", "anthropic/claude-opus-5-5")]),
		).toEqual([true, true]);
		expect(await readGuiPrefs()).toEqual({ theme: "dark", model: "anthropic/claude-opus-5-5" });

		expect(await writeGuiPref("theme", "")).toBe(true);
		expect(await readGuiPrefs()).toEqual({ model: "anthropic/claude-opus-5-5" });
	});

	test("a key the page does not keep is refused, and a broken file reads as nothing set", async () => {
		expect(await writeGuiPref("token", "secret")).toBe(false);
		expect(await readGuiPrefs()).toEqual({});

		await Bun.write(path.join(agentDir, "gui.json"), '{"theme": "dark", "prose": 3, "extra": "x"');
		expect(await readGuiPrefs()).toEqual({});
		await Bun.write(path.join(agentDir, "gui.json"), '{"theme": "dark", "prose": 3, "extra": "x"}');
		expect(await readGuiPrefs()).toEqual({ theme: "dark" });
	});
});
