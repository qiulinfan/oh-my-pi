import { describe, expect, it } from "bun:test";
import { matchCommands, slashQuery } from "../src/slash-commands";

describe("slashQuery", () => {
	it("is the name typed after a leading slash until a space", () => {
		expect(slashQuery("/")).toBe("");
		expect(slashQuery("/mo")).toBe("mo");
		expect(slashQuery("/model ")).toBeNull();
		expect(slashQuery("fix the /model bug")).toBeNull();
		expect(slashQuery("")).toBeNull();
	});
});

describe("matchCommands", () => {
	const commands = [{ name: "model" }, { name: "resume" }, { name: "mode" }, { name: "commit" }];

	it("lists names starting with the query first, then names containing it", () => {
		expect(matchCommands(commands, "mo").map(command => command.name)).toEqual(["model", "mode"]);
		expect(matchCommands(commands, "m").map(command => command.name)).toEqual(["model", "mode", "resume", "commit"]);
		expect(matchCommands(commands, "").length).toBe(4);
	});

	it("ignores case", () => {
		expect(matchCommands(commands, "MOD").map(command => command.name)).toEqual(["model", "mode"]);
	});
});
