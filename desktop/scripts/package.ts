#!/usr/bin/env bun
/**
 * Build omp.app from the Electron runtime: bundle src/main.ts, render the icon,
 * copy Electron.app as omp.app with this app in Contents/Resources/app, brand
 * its Info.plist and sign it ad hoc. `--install` then replaces
 * /Applications/omp.app by staged copy and rename (refusing while it runs).
 *
 * `--dev` builds out/omp-dev.app instead: the same app under its own name and
 * bundle id, so a development or test run keeps its preferences, data, logs
 * and single-instance lock apart from the installed omp.app and from every
 * other Electron app. It is never installed.
 *
 * Needs `bun install` and `bun run fetch-electron` first, and rsvg-convert
 * (Homebrew librsvg) for the icon.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const dev = process.argv.includes("--dev");
const identity = dev
	? { name: "omp-dev", pkg: "omp-desktop-dev", id: "com.qiulinfan.omp-desktop.dev" }
	: { name: "omp", pkg: "omp-desktop", id: "com.qiulinfan.omp-desktop" };
const root = path.join(import.meta.dir, "..");
const out = path.join(root, "out");
const bundle = path.join(out, `${identity.name}.app`);
const contents = path.join(bundle, "Contents");
const installed = "/Applications/omp.app";
/** Siblings of the installed app on the same volume, so each rename is atomic; not ending in .app, so LaunchServices ignores them. */
const staged = "/Applications/.omp.app.new";
const previous = "/Applications/.omp.app.previous";

async function buildMain(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [path.join(root, "src", "main.ts")],
		outdir: path.join(out, "build"),
		target: "node",
		format: "esm",
		external: ["electron"],
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("bundling src/main.ts failed");
	}
	return path.join(out, "build", "main.js");
}

/** macOS wants every size from 16 to 1024 pt, plain and @2x. */
async function buildIcon(): Promise<string> {
	const iconset = path.join(out, "omp.iconset");
	await fs.rm(iconset, { recursive: true, force: true });
	await fs.mkdir(iconset, { recursive: true });
	const svg = path.join(root, "assets", "icon.svg");
	for (const size of [16, 32, 128, 256, 512]) {
		await $`rsvg-convert -w ${size} -h ${size} ${svg} -o ${path.join(iconset, `icon_${size}x${size}.png`)}`;
		await $`rsvg-convert -w ${size * 2} -h ${size * 2} ${svg} -o ${path.join(iconset, `icon_${size}x${size}@2x.png`)}`;
	}
	const icns = path.join(out, "omp.icns");
	await $`iconutil -c icns ${iconset} -o ${icns}`;
	return icns;
}

async function assemble(mainJs: string, icns: string): Promise<void> {
	const electronApp = path.join(root, "node_modules", "electron", "dist", "Electron.app");
	await fs.access(electronApp).catch(() => {
		throw new Error("Electron.app is missing: run `bun install` and `bun run fetch-electron` in desktop/ first");
	});
	await fs.rm(bundle, { recursive: true, force: true });
	await $`ditto ${electronApp} ${bundle}`;

	const resources = path.join(contents, "Resources");
	await fs.rm(path.join(resources, "default_app.asar"), { force: true });
	const appDir = path.join(resources, "app");
	const { version } = (await Bun.file(path.join(root, "..", "packages", "coding-agent", "package.json")).json()) as {
		version: string;
	};
	await Bun.write(
		path.join(appDir, "package.json"),
		JSON.stringify(
			{ name: identity.pkg, productName: identity.name, version, type: "module", main: "main.js" },
			null,
			"\t",
		),
	);
	await fs.copyFile(mainJs, path.join(appDir, "main.js"));
	await fs.copyFile(icns, path.join(resources, "electron.icns"));

	const plist = path.join(contents, "Info.plist");
	const set = (key: string, value: string) => $`plutil -replace ${key} -string ${value} ${plist}`;
	await set("CFBundleName", identity.name);
	await set("CFBundleDisplayName", identity.name);
	await set("CFBundleIdentifier", identity.id);
	await set("CFBundleShortVersionString", version);
	await set("CFBundleVersion", version);
	await set("NSHumanReadableCopyright", "omp desktop, built from the oh-my-pi fork");

	// Rewriting files invalidates Electron's signature; macOS refuses to launch an unsigned arm64 app.
	await $`codesign --force --deep --sign - ${bundle}`.quiet();
}

async function appRunning(): Promise<boolean> {
	return (await $`pgrep -f ${`${installed}/Contents/MacOS/`}`.quiet().nothrow()).exitCode === 0;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.lstat(file);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Stage a verified copy next to the installed app and swap it in by rename, so
 * a failed or interrupted install leaves the old app working. A run that was
 * killed between the two renames is repaired by the next one.
 */
async function install(): Promise<void> {
	if (await appRunning()) throw new Error("omp.app is running: quit it, then run this again");
	if (!(await exists(installed)) && (await exists(previous))) await fs.rename(previous, installed);
	// ditto merges into an existing destination, so a stale staged copy must go first.
	await fs.rm(staged, { recursive: true, force: true });
	try {
		await $`ditto ${bundle} ${staged}`;
		await $`codesign --verify --deep --strict ${staged}`.quiet();
	} catch (err) {
		await fs.rm(staged, { recursive: true, force: true });
		throw err;
	}
	if (await appRunning()) {
		await fs.rm(staged, { recursive: true, force: true });
		throw new Error("omp.app was started during the install: quit it, then run this again");
	}
	// A full or partial leftover would make the rename below fail with ENOTEMPTY.
	await fs.rm(previous, { recursive: true, force: true });
	let moved = true;
	try {
		await fs.rename(installed, previous);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		moved = false;
	}
	try {
		await fs.rename(staged, installed);
	} catch (err) {
		if (moved) await fs.rename(previous, installed);
		throw err;
	}
	await fs.rm(previous, { recursive: true, force: true });
	console.log(`installed ${installed}`);
}

const installing = process.argv.includes("--install");
if (dev && installing) throw new Error("--dev builds are never installed");
const mainJs = await buildMain();
const icns = await buildIcon();
await assemble(mainJs, icns);
console.log(`built ${bundle}`);
if (installing) await install();
