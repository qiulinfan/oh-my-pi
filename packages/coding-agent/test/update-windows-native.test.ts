import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fetchForkBuild, FORK_REPO } from "../src/cli/fork-release";
import { downloadVerifiedBinary, replaceBinaryForUpdate } from "../src/cli/update-cli";
import type { Fetch } from "../src/cli/build-service";

async function executable(file: string, version: string): Promise<void> {
	const source = `public class Entry { public static void Main(string[] args) {
if (args.Length > 0 && args[0] == "--hold") { System.Console.WriteLine("ready"); System.Console.ReadLine(); }
else System.Console.WriteLine("omp/${version}"); } }`;
	const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const script = `Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(file)} -OutputType ConsoleApplication`;
	const result = Bun.spawnSync(
		["powershell.exe", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
		{ stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

test.skipIf(process.platform !== "win32")(
	"Windows installs a fork release while the old executable runs, and rolls back a bad replacement",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp native 更新 ' "));
		const target = path.join(root, "omp.exe");
		const next = path.join(root, "next.exe");
		const temp = path.join(root, "update.tmp.exe");
		const backup = path.join(root, "update.bak.exe");
		await executable(target, "999.0.1");
		await executable(next, "999.0.2");
		await fs.writeFile(path.join(root, "config.yml"), "private state stays");
		const old = Bun.spawn([target, "--hold"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
		try {
			await old.stdout.getReader().read();
			const bytes = await fs.readFile(next);
			const tag = "fork-v999.0.2-aaaaaaaaaa";
			const asset = "omp-windows-x64.exe";
			const download = `https://github.com/${FORK_REPO}/releases/download/${tag}/${asset}`;
			const digest = Bun.SHA256.hash(bytes, "hex");
			const fetchImpl: Fetch = async input => {
				const url = String(input);
				if (url.endsWith("/releases?per_page=20"))
					return Response.json([
						{
							tag_name: tag,
							target_commitish: "a".repeat(40),
							draft: false,
							prerelease: false,
							published_at: "2026-11-01T00:00:00Z",
							assets: [asset, asset + ".sha256"].map(name => ({
								name,
								size: bytes.length,
								browser_download_url: download + (name.endsWith(".sha256") ? ".sha256" : ""),
							})),
						},
					]);
				if (url === download + ".sha256") return new Response(digest + "  " + asset);
				if (url === download) return new Response(bytes);
				throw new Error("Unexpected update URL");
			};
			const build = await fetchForkBuild({ fetchImpl });
			await downloadVerifiedBinary({
				url: build.download,
				targetPath: temp,
				expectedSize: bytes.length,
				expectedDigest: `sha256:${digest}`,
				fetchImpl,
			});
			const verify = async (expected: string) => {
				const reported = Bun.spawnSync([target, "--version"], { stdout: "pipe", stderr: "pipe", windowsHide: true })
					.stdout.toString()
					.trim();
				return { ok: reported === `omp/${expected}`, actual: reported, path: target };
			};
			expect(
				(
					await replaceBinaryForUpdate({
						targetPath: target,
						tempPath: temp,
						backupPath: backup,
						expectedVersion: "999.0.2",
						verifyInstalledVersion: verify,
					})
				).ok,
			).toBe(true);
			expect(old.exitCode).toBeNull();
			expect(await Bun.file(backup).exists()).toBe(true);
			await fs.copyFile(backup, temp);
			await expect(
				replaceBinaryForUpdate({
					targetPath: target,
					tempPath: temp,
					backupPath: path.join(root, "failed.bak.exe"),
					expectedVersion: "999.0.3",
					verifyInstalledVersion: verify,
				}),
			).rejects.toThrow("restored previous");
			expect((await verify("999.0.2")).ok).toBe(true);
			expect(await Bun.file(path.join(root, "config.yml")).text()).toBe("private state stays");
		} finally {
			old.stdin.end();
			await old.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
