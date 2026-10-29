import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openCommand, resolveLinkedPath } from "@oh-my-pi/pi-coding-agent/gui/open-link";

// A transcript link is model output: clicking one must open what it names without ever running it.
describe("omp gui transcript links", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gui-open-link-"));
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "a.ts"), "x");
	fs.writeFileSync(path.join(dir, "run.command"), "echo hi");
	fs.mkdirSync(path.join(dir, "Tool.app"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("a relative link resolves in the session's directory, dropping a :line[:col] suffix", async () => {
		expect(await resolveLinkedPath("src/a.ts:12", dir)).toEqual({
			path: path.join(dir, "src", "a.ts"),
			directory: false,
		});
		expect(await resolveLinkedPath("a.ts:3:4", path.join(dir, "src"))).toEqual({
			path: path.join(dir, "src", "a.ts"),
			directory: false,
		});
		expect(await resolveLinkedPath(`file://${path.join(dir, "src")}`, undefined)).toEqual({
			path: path.join(dir, "src"),
			directory: true,
		});
	});

	test("web links, page anchors, missing files and relative links without a session resolve to nothing", async () => {
		for (const href of ["https://example.com", "mailto:a@b.c", "#top", "src/missing.ts", ""]) {
			expect(await resolveLinkedPath(href, dir)).toBeNull();
		}
		expect(await resolveLinkedPath("src/a.ts", undefined)).toBeNull();
	});

	test.if(process.platform === "darwin")("scripts open as text and apps are revealed, never launched", () => {
		expect(openCommand(path.join(dir, "run.command"), false)).toEqual(["open", "-t", path.join(dir, "run.command")]);
		expect(openCommand(path.join(dir, "Tool.app"), true)).toEqual(["open", "-R", path.join(dir, "Tool.app")]);
		expect(openCommand("/tmp/paper.pdf", false)).toEqual(["open", "/tmp/paper.pdf"]);
	});
});
