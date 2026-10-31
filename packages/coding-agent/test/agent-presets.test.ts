import { afterAll, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { AuthStorage, Effort } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyAgentPreset, loadAgentPreset, resolveLaunchPreset } from "@oh-my-pi/pi-coding-agent/config/agent-presets";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const PROJECT_MARKER = "project-context-marker-41c2";
const EXTRA_ROOT_MARKER = "extra-root-context-marker-8d1e";
const USER_AGENTS_MARKER = "user-agents-marker-0f6b";
const PRESET_PROMPT_MARKER = "preset-prompt-marker-77aa";
const USER_PRESET_MARKER = "user-preset-marker-3b90";
const CLI_APPEND_MARKER = "cli-append-marker-a51f";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

function skillFile(name: string): string {
	return `---\nname: ${name}\ndescription: Skill ${name} for the preset test.\n---\n\nBody of ${name}.\n`;
}

describe("agent presets", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let homedirSpy: Mock<typeof os.homedir>;
	const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

	beforeAll(async () => {
		tempDir = await TempDir.create("@agent-presets-");
		setAgentDir(tempDir.join("home/.omp/agent"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir.join("home"));
		await Promise.all([
			Bun.write(tempDir.join("project/AGENTS.md"), `${PROJECT_MARKER}\n`),
			Bun.write(tempDir.join("extra/AGENTS.md"), `${EXTRA_ROOT_MARKER}\n`),
			Bun.write(tempDir.join("home/.omp/agent/AGENTS.md"), `${USER_AGENTS_MARKER}\n`),
			Bun.write(tempDir.join("home/.omp/agent/skills/paper-reading/SKILL.md"), skillFile("paper-reading")),
			Bun.write(tempDir.join("home/.omp/agent/skills/unrelated-chore/SKILL.md"), skillFile("unrelated-chore")),
			Bun.write(
				tempDir.join("project/.omp/presets/reader.md"),
				`---\ndescription: Reads papers\nskills: [paper-reading]\nuser-context: false\nthinking: high\n---\n\n${PRESET_PROMPT_MARKER}\n`,
			),
			// Shadowed by the project preset of the same name.
			Bun.write(
				tempDir.join("home/.omp/agent/presets/reader.md"),
				`---\nthinking: low\n---\n${USER_PRESET_MARKER}\n`,
			),
			Bun.write(tempDir.join("home/.omp/agent/presets/chat.md"), "Just chat.\n"),
		]);
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		closeModelCache();
		homedirSpy.mockRestore();
		for (const key of ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		__resetDirsFromEnvForTests();
		await tempDir.remove();
	});

	/** Builds a session the way `omp --preset reader <flags>` does. */
	async function createPresetSession(flags: string[]) {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": false,
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		const args = parseArgs(["--cwd", tempDir.join("project"), "--add-dir", tempDir.join("extra"), ...flags]);
		applyAgentPreset(args, await loadAgentPreset("reader", tempDir.join("project")));
		const options = await buildSessionOptions(args, [], SessionManager.inMemory(args.cwd), modelRegistry, settings);
		const { session } = await createAgentSession({
			...options,
			agentDir: getAgentDir(),
			modelRegistry,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			enableLsp: false,
			skipPythonPreflight: true,
		});
		return { session, args };
	}

	it("runs the session on the project preset's prompt and skills, without the user-level AGENTS.md", async () => {
		const { session, args } = await createPresetSession([]);
		try {
			expect(args.thinking).toBe(Effort.High);
			const check = () => {
				const prompt = session.systemPrompt.join("\n");
				expect(prompt).toContain(PRESET_PROMPT_MARKER);
				expect(prompt).toContain(PROJECT_MARKER);
				expect(prompt).toContain(EXTRA_ROOT_MARKER);
				expect(prompt).not.toContain(USER_AGENTS_MARKER);
				expect(prompt).not.toContain(USER_PRESET_MARKER);
			};
			check();
			// A rebuild rediscovers context files; the user-level one must stay out.
			await session.refreshBaseSystemPrompt();
			check();
			expect(session.skills.map(skill => skill.name)).toEqual(["paper-reading"]);
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("lets a flag given on the command line win over the preset", async () => {
		const { session, args } = await createPresetSession([
			"--thinking",
			"low",
			"--skills",
			"unrelated-*",
			"--append-system-prompt",
			CLI_APPEND_MARKER,
		]);
		try {
			expect(args.thinking).toBe(Effort.Low);
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(CLI_APPEND_MARKER);
			expect(prompt).not.toContain(PRESET_PROMPT_MARKER);
			expect(session.skills.map(skill => skill.name)).toEqual(["unrelated-chore"]);
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("starts from the agentPreset setting unless the command line names a preset or --no-preset", async () => {
		const cwd = tempDir.join("project");
		const settings = Settings.isolated({ agentPreset: "reader" });
		const launch = async (flags: string[]) =>
			(await resolveLaunchPreset(parseArgs(["--cwd", cwd, ...flags]), settings, cwd))?.name ?? null;
		expect({
			bare: await launch([]),
			picked: await launch(["--preset", "chat"]),
			none: await launch(["--no-preset"]),
			unset: (await resolveLaunchPreset(parseArgs([]), Settings.isolated({}), cwd))?.name ?? null,
		}).toEqual({ bare: "reader", picked: "chat", none: null, unset: null });
		await expect(launch(["--preset", "chat", "--no-preset"])).rejects.toThrow("cannot be combined");
		// A default that names no preset fails the launch and says where the name came from.
		await expect(resolveLaunchPreset(parseArgs([]), Settings.isolated({ agentPreset: "gone" }), cwd)).rejects.toThrow(
			"named by the agentPreset setting",
		);
	});

	it("names the available presets when the requested one does not exist", async () => {
		await expect(loadAgentPreset("missing", tempDir.join("project"))).rejects.toThrow(
			'Unknown preset "missing". Available: reader, chat.',
		);
	});

	it("refuses a preset whose fields are malformed instead of widening the session", async () => {
		await Bun.write(tempDir.join("bad/.omp/presets/broken.md"), "---\nthinking: loud\n---\nBody\n");
		await expect(loadAgentPreset("broken", tempDir.join("bad"))).rejects.toThrow("unknown thinking level");
	});
});
