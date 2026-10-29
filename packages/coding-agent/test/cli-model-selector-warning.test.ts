import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// `--model` with a typo used to run the nearest model with no word to the user.
describe("--model approximate match", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cli-model-warning-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function startWith(model: string, settings: Settings) {
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		const warnings: string[] = [];
		const options = await buildSessionOptions(
			parseArgs(["--model", model]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
			warning => warnings.push(warning),
		);
		return { options, warnings };
	}

	test("a typo starts on the nearest model and reports the substitution", async () => {
		const { options, warnings } = await startWith("anthropic/claude-haku-4-5", Settings.isolated());
		expect(options.model?.id).toBe("claude-haiku-4-5");
		expect(warnings).toEqual(['"anthropic/claude-haku-4-5" is not a known model; using anthropic/claude-haiku-4-5']);
	});

	test("model.exactMatch refuses the substitution", async () => {
		const { options, warnings } = await startWith(
			"anthropic/claude-haku-4-5",
			Settings.isolated({ "model.exactMatch": true }),
		);
		expect(options.model).toBeUndefined();
		expect(warnings).toEqual([]);
	});
});
