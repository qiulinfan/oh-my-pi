import { describe, expect, it } from "bun:test";
import {
	FORK_REPO,
	fetchForkBuild,
	forkAssetName,
	forkRelation,
	pickForkRelease,
} from "@oh-my-pi/pi-coding-agent/cli/fork-release";
import type { Fetch } from "@oh-my-pi/pi-coding-agent/cli/build-service";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const DIGEST = "c".repeat(64);
const DOWNLOAD = `https://github.com/${FORK_REPO}/releases/download`;

function release(tag: string, commit: string, publishedAt: string, assets: string[], extra: object = {}) {
	return {
		tag_name: tag,
		target_commitish: commit,
		draft: false,
		prerelease: false,
		published_at: publishedAt,
		assets: assets.map(name => ({ name, size: 1234, browser_download_url: `${DOWNLOAD}/${tag}/${name}` })),
		...extra,
	};
}

const MAC = ["omp-darwin-arm64", "omp-darwin-arm64.sha256"];
const WINDOWS = ["omp-windows-x64.exe", "omp-windows-x64.exe.sha256"];

/** A fetch that answers GitHub's API and download URLs from a table, recording every URL asked. */
function fakeFetch(answers: Record<string, unknown>): { fetchImpl: Fetch; urls: string[] } {
	const urls: string[] = [];
	const fetchImpl: Fetch = async input => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		if (!(url in answers)) return new Response("not found", { status: 404 });
		const body = answers[url];
		return typeof body === "string" ? new Response(body) : Response.json(body);
	};
	return { fetchImpl, urls };
}

describe("forkAssetName", () => {
	it("names the binary the fork publishes for each platform", () => {
		expect(forkAssetName("darwin", "arm64")).toBe("omp-darwin-arm64");
		expect(forkAssetName("linux", "x64")).toBe("omp-linux-x64");
		expect(forkAssetName("win32", "x64")).toBe("omp-windows-x64.exe");
		expect(forkAssetName("darwin", "x64")).toBeUndefined();
	});
});

describe("pickForkRelease", () => {
	it("takes the newest published fork release carrying the platform's binary and digest", () => {
		const releases = [
			release("fork-v18.14.0-bbbbbbbbbb", COMMIT_B, "2026-11-01T03:00:00Z", WINDOWS),
			release("fork-v18.14.0-aaaaaaaaaa", COMMIT_A, "2026-11-01T02:00:00Z", MAC),
			release("fork-v18.13.0-aaaaaaaaaa", COMMIT_A, "2026-10-01T02:00:00Z", MAC),
		];
		expect(pickForkRelease(releases, "omp-darwin-arm64")?.tag_name).toBe("fork-v18.14.0-aaaaaaaaaa");
	});

	it("skips drafts, prereleases, other tags and a binary without its digest", () => {
		const releases = [
			release("fork-v18.14.0-aaaaaaaaaa", COMMIT_A, "2026-11-01T05:00:00Z", MAC, { draft: true }),
			release("fork-v18.14.0-aaaaaaaaaa", COMMIT_A, "2026-11-01T04:00:00Z", MAC, { prerelease: true }),
			release("v18.14.0", COMMIT_A, "2026-11-01T03:00:00Z", MAC),
			release("fork-v18.14.0-aaaaaaaaaa", COMMIT_A, "2026-11-01T02:00:00Z", ["omp-darwin-arm64"]),
		];
		expect(pickForkRelease(releases, "omp-darwin-arm64")).toBeUndefined();
	});
});

describe("fetchForkBuild", () => {
	it("reads only the fork's releases and the digest beside the binary", async () => {
		const tag = "fork-v18.14.0-aaaaaaaaaa";
		const { fetchImpl, urls } = fakeFetch({
			[`https://api.github.com/repos/${FORK_REPO}/releases?per_page=20`]: [
				release(tag, COMMIT_A, "2026-11-01T02:00:00Z", MAC),
			],
			[`${DOWNLOAD}/${tag}/omp-darwin-arm64.sha256`]: `${DIGEST}  omp-darwin-arm64\n`,
		});
		const build = await fetchForkBuild({ fetchImpl, platform: "darwin", arch: "arm64" });
		expect(build).toEqual({
			tag,
			version: "18.14.0",
			commit: COMMIT_A,
			file: { name: "omp-darwin-arm64", size: 1234, sha256: DIGEST },
			download: `${DOWNLOAD}/${tag}/omp-darwin-arm64`,
		});
		for (const url of urls) {
			expect(url.startsWith(`https://api.github.com/repos/${FORK_REPO}/`) || url.startsWith(`${DOWNLOAD}/`)).toBe(
				true,
			);
		}
	});

	it("refuses a release whose digest file holds no digest", async () => {
		const tag = "fork-v18.14.0-aaaaaaaaaa";
		const { fetchImpl } = fakeFetch({
			[`https://api.github.com/repos/${FORK_REPO}/releases?per_page=20`]: [
				release(tag, COMMIT_A, "2026-11-01T02:00:00Z", MAC),
			],
			[`${DOWNLOAD}/${tag}/omp-darwin-arm64.sha256`]: "not a digest",
		});
		await expect(fetchForkBuild({ fetchImpl, platform: "darwin", arch: "arm64" })).rejects.toThrow(
			"holds no SHA-256 digest",
		);
	});
});

describe("forkRelation", () => {
	const compareUrl = `https://api.github.com/repos/${FORK_REPO}/compare/${COMMIT_A}...${COMMIT_B}`;
	const build = { version: "18.14.0", commit: COMMIT_B };

	it("decides by version when the versions differ, without asking GitHub", async () => {
		const { fetchImpl, urls } = fakeFetch({});
		expect(await forkRelation(build, { fetchImpl, installedVersion: "18.13.0", installedCommit: COMMIT_A })).toBe(
			"newer",
		);
		expect(await forkRelation(build, { fetchImpl, installedVersion: "18.15.0", installedCommit: COMMIT_A })).toBe(
			"older",
		);
		expect(urls).toEqual([]);
	});

	it("is the same build when the commits match", async () => {
		const { fetchImpl } = fakeFetch({});
		expect(await forkRelation(build, { fetchImpl, installedVersion: "18.14.0", installedCommit: COMMIT_B })).toBe(
			"same",
		);
	});

	it("asks GitHub how the commits relate at the same version", async () => {
		for (const [status, relation] of [
			["ahead", "newer"],
			["behind", "older"],
			["identical", "same"],
			["diverged", "diverged"],
		] as const) {
			const { fetchImpl } = fakeFetch({ [compareUrl]: { status } });
			expect(await forkRelation(build, { fetchImpl, installedVersion: "18.14.0", installedCommit: COMMIT_A })).toBe(
				relation,
			);
		}
	});
});
