import { afterEach, describe, expect, it } from "bun:test";
import { getSettingDef } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { createSettingsHost } from "../src/config/settings-ui";

const NOTE = "Terminal only: omp gui draws its own and ignores it.";

function description(path: string): string | undefined {
	return getSettingDef(createSettingsHost().entries, path)?.description;
}

describe("terminal-only settings in the settings panel", () => {
	const previous = Bun.env.TERM_PROGRAM;
	afterEach(() => {
		if (previous === undefined) delete Bun.env.TERM_PROGRAM;
		else Bun.env.TERM_PROGRAM = previous;
	});

	it("say so inside omp gui, and only for the settings a terminal alone acts on", () => {
		Bun.env.TERM_PROGRAM = "omp-gui";
		expect(description("theme.dark")).toBe(`Theme used when the terminal has a dark background. ${NOTE}`);
		expect(description("tui.mouse")).toEndWith(NOTE);
		expect(description("tui.renderMermaid")).not.toContain(NOTE);
	});

	it("say nothing more in a terminal", () => {
		Bun.env.TERM_PROGRAM = "ghostty";
		expect(description("theme.dark")).not.toContain(NOTE);
	});
});
