/**
 * Updates from this fork's own GitHub Releases.
 *
 * The fork's CI (`.github/workflows/fork_omp.yml`) publishes every push to
 * `main` as a release tagged `fork-v<version>-<commit10>`, with one binary per
 * platform and its `.sha256`. `omp update` and the startup check read only
 * these releases: upstream's build service and npm would install upstream's
 * build over the fork. Fork builds of one upstream version share its version
 * number, so a release is newer when GitHub says its commit is ahead of the
 * commit this binary was built from.
 */
import { APP_NAME, compareVersions, VERSION } from "@oh-my-pi/pi-utils";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";
import type { BuildAnswer, Fetch } from "./build-service";

export const FORK_REPO = "qiulinfan/oh-my-pi";
const API = `https://api.github.com/repos/${FORK_REPO}`;
const CHECK_TIMEOUT_MS = 30_000;
const TAG = /^fork-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-([0-9a-f]{7,40})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The commit this binary was compiled from, defined by `scripts/compile-binary.ts`; undefined when run from source. */
export const BUILD_COMMIT: string | undefined = process.env.PI_BUILD_COMMIT || undefined;

/** The release asset holding this platform's binary, or undefined where the fork publishes none. */
export function forkAssetName(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string | undefined {
	if (platform === "darwin" && arch === "arm64") return "omp-darwin-arm64";
	if (platform === "linux" && arch === "x64") return "omp-linux-x64";
	if (platform === "win32" && arch === "x64") return "omp-windows-x64.exe";
	return undefined;
}

export interface ForkBuild extends BuildAnswer {
	tag: string;
	/** Full SHA of the commit the release was built from. */
	commit: string;
}

/** How a release relates to the build installed here. */
export type ForkRelation = "newer" | "same" | "older" | "diverged";

export interface ForkReleaseOptions {
	fetchImpl?: Fetch;
	timeoutMs?: number;
	platform?: NodeJS.Platform;
	arch?: string;
}

interface GitHubAsset {
	name: string;
	size: number;
	browser_download_url: string;
}

interface GitHubRelease {
	tag_name: string;
	target_commitish: string;
	draft: boolean;
	prerelease: boolean;
	published_at: string | null;
	assets: GitHubAsset[];
}

function headers(): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": `${APP_NAME}/${VERSION}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

async function getJson(url: string, options: ForkReleaseOptions): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(url, {
			headers: headers(),
			signal: withTimeoutSignal(timeoutMs),
		});
		if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText} for ${url}`);
		return await response.json();
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out asking GitHub for ${FORK_REPO} releases after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}

/** Pick the newest published release carrying `assetName` and its `.sha256`. */
export function pickForkRelease(releases: unknown, assetName: string): GitHubRelease | undefined {
	if (!Array.isArray(releases)) throw new Error(`Unexpected answer listing ${FORK_REPO} releases`);
	const candidates = (releases as GitHubRelease[]).filter(
		release =>
			!release.draft &&
			!release.prerelease &&
			release.published_at &&
			TAG.test(release.tag_name) &&
			/^[0-9a-f]{40}$/.test(release.target_commitish) &&
			release.assets.some(asset => asset.name === assetName) &&
			release.assets.some(asset => asset.name === `${assetName}.sha256`),
	);
	candidates.sort((a, b) => Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""));
	return candidates[0];
}

/** The newest fork build for this platform, its digest read from the release's `.sha256`. */
export async function fetchForkBuild(options: ForkReleaseOptions = {}): Promise<ForkBuild> {
	const assetName = forkAssetName(options.platform, options.arch);
	if (!assetName) {
		throw new Error(
			`${FORK_REPO} publishes no ${APP_NAME} build for ${options.platform ?? process.platform}-${options.arch ?? process.arch}`,
		);
	}
	const release = pickForkRelease(await getJson(`${API}/releases?per_page=20`, options), assetName);
	if (!release) throw new Error(`No ${FORK_REPO} release carries ${assetName} yet`);
	const binary = release.assets.find(asset => asset.name === assetName)!;
	const digestAsset = release.assets.find(asset => asset.name === `${assetName}.sha256`)!;

	const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
	const digestResponse = await (options.fetchImpl ?? fetch)(digestAsset.browser_download_url, {
		redirect: "follow",
		headers: { "User-Agent": `${APP_NAME}/${VERSION}` },
		signal: withTimeoutSignal(timeoutMs),
	});
	if (!digestResponse.ok) throw new Error(`Could not read ${digestAsset.name}: ${digestResponse.status}`);
	const sha256 = (await digestResponse.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (!SHA256_HEX.test(sha256)) throw new Error(`${digestAsset.name} holds no SHA-256 digest`);
	if (!binary.browser_download_url.startsWith(`https://github.com/${FORK_REPO}/releases/download/`)) {
		throw new Error(`${assetName} is not served from ${FORK_REPO}'s releases`);
	}

	return {
		tag: release.tag_name,
		version: TAG.exec(release.tag_name)![1],
		commit: release.target_commitish,
		file: { name: assetName, size: binary.size, sha256 },
		download: binary.browser_download_url,
	};
}

/**
 * Whether `build` would move this install forward. A higher version is newer
 * and a lower one older; at the same version GitHub's comparison of the two
 * commits decides, so a local build of commits not pushed yet is never
 * replaced by an older release.
 */
export async function forkRelation(
	build: Pick<ForkBuild, "version" | "commit">,
	options: ForkReleaseOptions & { installedVersion?: string; installedCommit?: string } = {},
): Promise<ForkRelation> {
	const installedVersion = options.installedVersion ?? VERSION;
	const installedCommit = options.installedCommit ?? BUILD_COMMIT;
	const byVersion = compareVersions(build.version, installedVersion);
	if (byVersion > 0) return "newer";
	if (byVersion < 0) return "older";
	if (!installedCommit) return "newer";
	if (build.commit.startsWith(installedCommit) || installedCommit.startsWith(build.commit)) return "same";
	const comparison = await getJson(`${API}/compare/${installedCommit}...${build.commit}`, options);
	const status = (comparison as { status?: unknown }).status;
	if (status === "ahead") return "newer";
	if (status === "identical") return "same";
	if (status === "behind") return "older";
	return "diverged";
}

/** `18.14.0 (730f60a272)`: a fork build's version with its commit. */
export function forkBuildLabel(version: string, commit: string | undefined): string {
	return commit ? `${version} (${commit.slice(0, 10)})` : version;
}
