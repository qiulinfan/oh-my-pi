#!/usr/bin/env bun
/**
 * Bundle the extension into dist/extension.js: one CommonJS file, as VS Code
 * loads extensions, with the `vscode` module left external. `--package` then
 * writes out/omp-vscode.vsix, and `--install` packages it and installs it into
 * the VS Code that `code` names.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const root = path.join(import.meta.dir, "..");
const install = process.argv.includes("--install");
const pack = install || process.argv.includes("--package");

const result = await Bun.build({
	entrypoints: [path.join(root, "src", "extension.ts")],
	outdir: path.join(root, "dist"),
	naming: "extension.js",
	target: "node",
	format: "cjs",
	external: ["vscode"],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`built ${path.join(root, "dist", "extension.js")}`);

if (pack) {
	const vsix = path.join(root, "out", "omp-vscode.vsix");
	await fs.mkdir(path.dirname(vsix), { recursive: true });
	// The bundle carries every dependency, so the package needs none of node_modules.
	await $`${path.join(root, "node_modules", ".bin", "vsce")} package --no-dependencies --skip-license --out ${vsix}`.cwd(
		root,
	);
	if (install) await $`code --install-extension ${vsix} --force`;
}
