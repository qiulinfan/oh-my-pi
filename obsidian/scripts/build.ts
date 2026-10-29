#!/usr/bin/env bun
/**
 * Bundle the plugin into out/ (main.js, manifest.json, styles.css): one
 * CommonJS file, as Obsidian loads plugins, with Obsidian's own modules left
 * external. `--vault <dir>` then copies the three files into that vault's
 * .obsidian/plugins/omp-sidebar/; enable the plugin in Obsidian's settings.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import manifest from "../manifest.json";

const root = path.join(import.meta.dir, "..");
const out = path.join(root, "out");
const files = ["main.js", "manifest.json", "styles.css"];

const vaultAt = process.argv.indexOf("--vault");
const vault = vaultAt === -1 ? undefined : process.argv[vaultAt + 1];
if (vaultAt !== -1 && !vault) throw new Error("--vault needs the vault's directory");

const result = await Bun.build({
	entrypoints: [path.join(root, "src", "main.ts")],
	outdir: out,
	naming: "main.js",
	target: "node",
	format: "cjs",
	external: ["obsidian", "electron"],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
await fs.copyFile(path.join(root, "manifest.json"), path.join(out, "manifest.json"));
await fs.copyFile(path.join(root, "styles.css"), path.join(out, "styles.css"));
console.log(`built ${out}`);

if (vault) {
	const config = path.join(path.resolve(vault), ".obsidian");
	// A directory without .obsidian/ is not a vault Obsidian has opened; do not make one.
	if (!(await fs.stat(config).catch(() => null))?.isDirectory()) throw new Error(`${vault} is not an Obsidian vault`);
	const target = path.join(config, "plugins", manifest.id);
	await fs.mkdir(target, { recursive: true });
	for (const file of files) await fs.copyFile(path.join(out, file), path.join(target, file));
	console.log(`installed into ${target}`);
}
