import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { cfgDisplayWorkDetail } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { getWorkDetail, setWorkDetail } from "@oh-my-pi/pi-tui/chat/work-detail";
import { WorkDetailSelectorComponent } from "@oh-my-pi/pi-tui/overlays/work-detail-selector";
import { Container } from "@oh-my-pi/pi-tui";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const releases: (() => void)[] = [];

/** A TSP surface that draws data-first tool rows (omp gui). */
const cx: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	for (const release of releases.splice(0)) release();
	setWorkDetail("standard");
});

function boundSettings(overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated(overrides);
	releases.push(bindEffects(settings));
	return settings;
}

describe("--work-detail", () => {
	it("parses each mode and records any other value as a usage error", () => {
		expect(parseArgs(["--work-detail", "compact"]).workDetail).toBe("compact");
		expect(parseArgs(["--work-detail=verbose", "hi"])).toMatchObject({ workDetail: "verbose", messages: ["hi"] });
		const bogus = parseArgs(["--work-detail", "loud"]);
		expect(bogus.workDetail).toBeUndefined();
		expect(bogus.invalidFlagValues).toEqual([expect.stringContaining('Invalid --work-detail value: "loud"')]);
	});
});

describe("display.workDetail", () => {
	it("re-describes existing tool rows when the session's mode changes", () => {
		const settings = boundSettings();
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const tool = new ToolExecutionComponent("write", { path: "a.ts", content: "x\ny" }, {}, undefined, ui);
		try {
			expect(tool.describe(cx).p).toMatchObject({ status: "pending", collapsed: false });
			// What `--work-detail compact` and the composer chip do: a runtime override.
			cfgDisplayWorkDetail.override(settings, "compact");
			expect(tool.describe(cx).p).toMatchObject({ collapsed: true, preview: "none" });
		} finally {
			tool.dispose();
		}
	});

	it("applies a composer-picker choice to this session only; a /settings choice then takes over", () => {
		const settings = boundSettings();
		const editorContainer = new Container();
		const ctx = createInteractiveModeContext({
			settings,
			editorContainer,
			ui: { getFocused: () => null, setFocus: () => {}, requestRender: () => {} },
		});
		const controller = new SelectorController(ctx);

		controller.showWorkDetailSelector();
		const picker = editorContainer.children[0];
		expect(picker).toBeInstanceOf(WorkDetailSelectorComponent);
		const list = (picker as WorkDetailSelectorComponent).getSelectList();
		list.setSelectedIndex(0);
		list.onSelect?.({ value: "compact", label: "compact" });
		expect(getWorkDetail()).toBe("compact");
		expect(cfgDisplayWorkDetail.provenance(settings)).toBe("runtime");

		// The settings panel writes the persisted layer, then reports the change.
		cfgDisplayWorkDetail.set(settings, "verbose");
		expect(getWorkDetail()).toBe("compact");
		controller.handleSettingsPanelChange(cfgDisplayWorkDetail.id, "verbose");
		expect(getWorkDetail()).toBe("verbose");
	});

	it("keeps an approved session-only cfg:// write after it is reported as applied", () => {
		const settings = boundSettings();
		const ctx = createInteractiveModeContext({ settings });
		const controller = new SelectorController(ctx);

		// cfg-protocol's non-save path: override the leaf, then report through the shared `applied` host.
		cfgDisplayWorkDetail.override(settings, "verbose");
		controller.handleSettingChange(cfgDisplayWorkDetail.id, cfgDisplayWorkDetail.get(settings));
		expect(cfgDisplayWorkDetail.get(settings)).toBe("verbose");
		expect(getWorkDetail()).toBe("verbose");
	});
});
